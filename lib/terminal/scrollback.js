/**
 * Scrollback for remote PTY sessions: a streaming terminal sanitizer plus a
 * bounded, newest-relative line ring.
 *
 * The sanitizer strips terminal control sequences without full emulation
 * (CSI, OSC, DCS/SOS/PM/APC and short ESC sequences), keeps printable text,
 * and handles line editing the way a plain terminal would:
 *
 * - `\n` / `\r\n` end the current line;
 * - `\r` moves the cursor to column 0 (subsequent characters overwrite);
 * - `\b` moves the cursor one code point left (subsequent characters overwrite);
 * - `\t` advances to the next 8-column tab stop;
 * - other C0 controls and DEL are dropped; incomplete escapes at a chunk
 *   boundary are carried into the next chunk.
 *
 * The ring keeps the newest lines bounded by `maxLines` and `maxBytes` (oldest
 * dropped first, `truncated` set once anything was lost) and never splits a
 * UTF-16 surrogate pair or a UTF-8 sequence. Snapshots use newest-relative
 * offsets: `offset: 0` is the newest retained line, `offset: 1` the one before
 * it, and so on, which lets the model page backwards through output.
 *
 * ```js
 * const scrollback = createScrollback({ maxLines: 2000, maxBytes: 2_000_000 })
 * scrollback.append("\x1b[31mhello\x1b[0m\n")
 * scrollback.snapshot({ offset: 0, count: 100 }) // { text, totalLines, lineBegin, lineEnd, truncated }
 * ```
 *
 * This module is pure: no imports, no I/O, no timers.
 */

/** Retained lines used when `maxLines` is missing or invalid. */
export const DEFAULT_MAX_LINES = 2_000
/** Retained bytes used when `maxBytes` is missing or invalid. */
export const DEFAULT_MAX_BYTES = 2_000_000
/** Neutral default line count for one snapshot page. */
export const DEFAULT_SNAPSHOT_COUNT = 500
/** Tab stop width used to expand `\t`. */
export const TAB_WIDTH = 8

/**
 * Longest incomplete escape sequence carried between chunks. Anything longer
 * is dropped (a malformed/never-terminated sequence must not grow unbounded).
 */
const MAX_PENDING_ESCAPE_CHARS = 8_192

/**
 * Streaming sanitizer state. One instance per stream; pass it to
 * {@link sanitizeChunk} for every chunk.
 *
 * @typedef {object} SanitizerState
 * @property {string} pending incomplete escape sequence carried from the last chunk
 */

/**
 * @returns {SanitizerState}
 */
export function createSanitizerState() {
  return { pending: '' }
}

/**
 * Read a positive integer option, falling back when absent/invalid.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback
}

/**
 * Drop C0 controls and DEL except tab, newline, carriage return and backspace
 * (those four are line-editing semantics owned by the ring).
 *
 * @param {string} text
 * @returns {string}
 */
function stripControl(text) {
  if (text.length === 0) return text
  return text.replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

/**
 * Scan one escape sequence starting at `start` (the ESC itself).
 *
 * @param {string} input
 * @param {number} start
 * @returns {{ next: number } | null} `null` when the sequence is incomplete
 */
function scanEscape(input, start) {
  if (start + 1 >= input.length) return null
  const kind = input[start + 1]
  if (kind === '[') return scanCsi(input, start)
  if (kind === ']') return scanString(input, start)
  if (kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
    // DCS / SOS / PM / APC: terminated by ST (ESC \).
    return scanControlString(input, start)
  }
  // Short escape: ESC + optional intermediates (0x20-0x2f) + final (0x30-0x7e).
  let index = start + 1
  while (index < input.length) {
    const code = input.charCodeAt(index)
    if (code >= 0x20 && code <= 0x2f) {
      index += 1
      continue
    }
    if (code >= 0x30 && code <= 0x7e) return { next: index + 1 }
    // Malformed: strip the ESC only and reprocess the next character.
    return { next: start + 1 }
  }
  return null
}

/**
 * CSI: ESC `[` … final byte 0x40-0x7e.
 *
 * @param {string} input
 * @param {number} start
 * @returns {{ next: number } | null}
 */
function scanCsi(input, start) {
  let index = start + 2
  while (index < input.length) {
    const code = input.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return { next: index + 1 }
    if (code < 0x20) {
      // Malformed (a control character interrupted the sequence): strip only the
      // ESC so the control character keeps its meaning for the line ring.
      return { next: start + 1 }
    }
    index += 1
  }
  return null
}

/**
 * OSC: ESC `]` … terminated by BEL (0x07) or ST (ESC `\`).
 *
 * @param {string} input
 * @param {number} start
 * @returns {{ next: number } | null}
 */
function scanString(input, start) {
  let index = start + 2
  while (index < input.length) {
    const ch = input[index]
    if (ch === '\u0007') return { next: index + 1 }
    if (ch === '\u001b') {
      if (index + 1 >= input.length) return null
      if (input[index + 1] === '\\') return { next: index + 2 }
      // Malformed terminator: end the string before the ESC and reprocess it.
      return { next: Math.max(start + 2, index) }
    }
    index += 1
  }
  return null
}

/**
 * DCS/SOS/PM/APC: only ST (ESC `\`) terminates; BEL is tolerated as a fallback
 * terminator for stray control strings.
 *
 * @param {string} input
 * @param {number} start
 * @returns {{ next: number } | null}
 */
function scanControlString(input, start) {
  let index = start + 2
  while (index < input.length) {
    if (input[index] === '\u0007') return { next: index + 1 }
    if (input[index] === '\u001b') {
      if (index + 1 >= input.length) return null
      if (input[index + 1] === '\\') return { next: index + 2 }
      return { next: Math.max(start + 2, index) }
    }
    index += 1
  }
  return null
}

/**
 * Strip terminal escape sequences from one streaming chunk.
 *
 * Incomplete sequences at the end of a chunk are retained in `state.pending`
 * and completed by the next call. The returned text may still contain `\t`,
 * `\n`, `\r` and `\b` — those are line-editing semantics owned by the ring.
 *
 * @param {SanitizerState} state
 * @param {string} text
 * @returns {string} printable text with escape sequences removed
 */
export function sanitizeChunk(state, text) {
  const target = state && typeof state === 'object' ? state : createSanitizerState()
  const pending = typeof target.pending === 'string' ? target.pending : ''
  const input = pending + (typeof text === 'string' ? text : String(text ?? ''))
  target.pending = ''
  if (input.length === 0) return ''

  let output = ''
  let index = 0
  while (index < input.length) {
    const escape = input.indexOf('\u001b', index)
    if (escape < 0) {
      output += stripControl(input.slice(index))
      break
    }
    if (escape > index) output += stripControl(input.slice(index, escape))
    const parsed = scanEscape(input, escape)
    if (parsed === null) {
      const rest = input.slice(escape)
      if (rest.length <= MAX_PENDING_ESCAPE_CHARS) target.pending = rest
      break
    }
    index = parsed.next
  }
  return output
}

/**
 * Flush whatever remains in a sanitizer state at end of stream. An incomplete
 * escape sequence is discarded (it was never a complete terminal instruction).
 *
 * @param {SanitizerState} state
 * @returns {string}
 */
export function flushSanitizer(state) {
  if (!state || typeof state !== 'object' || typeof state.pending !== 'string') return ''
  state.pending = ''
  return ''
}

/**
 * Keep the tail of `text` within `maxBytes` UTF-8 bytes without splitting a
 * code point.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function utf8Tail(text, maxBytes) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  if (Buffer.byteLength(value, 'utf8') <= limit) return { text: value, truncated: false }
  if (limit === 0) return { text: '', truncated: value.length > 0 }
  const chars = Array.from(value)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1], 'utf8')
    if (bytes + size > limit) break
    bytes += size
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

/** @param {number} code */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

/** @param {number} code */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Index of the code point boundary before `index` in `value`.
 *
 * @param {string} value
 * @param {number} index
 * @returns {number}
 */
function previousBoundary(value, index) {
  const candidate = index - 1
  if (candidate <= 0) return 0
  if (isLowSurrogate(value.charCodeAt(candidate)) && isHighSurrogate(value.charCodeAt(candidate - 1))) {
    return candidate - 1
  }
  return candidate
}

/**
 * Split a string into code points (strings of length 1 or 2).
 *
 * @param {string} value
 * @returns {string[]}
 */
function splitCodePoints(value) {
  const points = []
  for (const point of value) points.push(point)
  return points
}

/**
 * Create a bounded line ring with a streaming sanitizer.
 *
 * @param {{ maxLines?: number, maxBytes?: number }} [options]
 * @returns {{
 *   append(text: string): string,
 *   snapshot(options?: { offset?: number, count?: number, maxBytes?: number }): {
 *     text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean,
 *   },
 *   clearContents(): void,
 *   readonly totalLines: number,
 *   readonly truncated: boolean,
 *   readonly bytes: number,
 * }}
 */
export function createScrollback(options = {}) {
  const maxLines = positiveInt(options.maxLines, DEFAULT_MAX_LINES)
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES)
  const sanitizer = createSanitizerState()

  /** Completed (newline-terminated) retained lines. */
  let lines = []
  /** Index of the first retained entry in {@link lines}. */
  let head = 0
  /** Sum of UTF-8 bytes of the retained completed lines. */
  let linesBytes = 0
  /** The not-yet-terminated current line. */
  let current = ''
  /** Tracked UTF-8 bytes of {@link current}. */
  let currentBytes = 0
  /** Cursor position in UTF-16 code units inside {@link current}. */
  let cursor = 0
  /** True once any retained output was dropped. */
  let dropped = false

  /** @returns {number} retained completed line count */
  function completedCount() {
    return lines.length - head
  }

  /** @returns {number} number of visible lines (completed + non-empty current) */
  function visibleCount() {
    return completedCount() + (current.length > 0 ? 1 : 0)
  }

  /** @returns {number} bytes of the text a snapshot would join */
  function retainedBytes() {
    return linesBytes + currentBytes + Math.max(0, visibleCount() - 1)
  }

  /** Compact the array once enough of the front has been evicted. */
  function compactLines() {
    if (head > 0 && (head >= 256 || head * 2 >= lines.length)) {
      lines = lines.slice(head)
      head = 0
    }
  }

  /**
   * Drop the oldest completed line. Caller must have at least one completed
   * line and must check the bounds before calling.
   */
  function dropOldestLine() {
    const line = lines[head]
    linesBytes -= Buffer.byteLength(line, 'utf8')
    head += 1
    dropped = true
    compactLines()
  }

  /**
   * Keep the current line within the overall byte budget: when a single line
   * alone exceeds `maxBytes`, drop a batch from its front (the tail is what the
   * remote side was writing most recently). Amortized: one trim per ~maxBytes/2
   * appended bytes, so building a long line stays linear.
   */
  function trimCurrent() {
    const target = Math.max(1, Math.floor(maxBytes / 2))
    if (currentBytes <= target) return
    const overflow = currentBytes - target
    let removedUnits = 0
    let removedBytes = 0
    while (removedUnits < current.length && removedBytes < overflow) {
      const codePoint = current.codePointAt(removedUnits)
      const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1
      removedBytes += Buffer.byteLength(current.slice(removedUnits, removedUnits + width), 'utf8')
      removedUnits += width
    }
    current = current.slice(removedUnits)
    currentBytes -= removedBytes
    cursor = Math.max(0, cursor - removedUnits)
    dropped = true
  }

  /** Enforce the line/byte bounds (oldest dropped first). */
  function enforceBounds() {
    while (completedCount() > 0 && (visibleCount() > maxLines || retainedBytes() > maxBytes)) {
      dropOldestLine()
    }
    if (currentBytes > maxBytes) trimCurrent()
  }

  /**
   * Append one code point string at the cursor (overwriting when the cursor is
   * inside the line).
   *
   * @param {string} point
   */
  function putCodePoint(point) {
    if (cursor >= current.length) {
      appendRun(point)
      return
    }
    const existing = current.codePointAt(cursor)
    const oldPoint = existing === undefined ? '' : String.fromCodePoint(existing)
    current = current.slice(0, cursor) + point + current.slice(cursor + oldPoint.length)
    currentBytes += Buffer.byteLength(point, 'utf8') - Buffer.byteLength(oldPoint, 'utf8')
    cursor += point.length
  }

  /**
   * Append a printable run at the end of the line. Accounts for a surrogate pair
   * split across chunk boundaries (a lone high surrogate was counted as 3 bytes;
   * completing the pair costs 1 more).
   *
   * @param {string} run
   */
  function appendRun(run) {
    if (run.length === 0) return
    let bytes = Buffer.byteLength(run, 'utf8')
    if (current.length > 0) {
      const last = current.charCodeAt(current.length - 1)
      const first = run.charCodeAt(0)
      if (isHighSurrogate(last) && isLowSurrogate(first)) bytes -= 2
    }
    current += run
    currentBytes += bytes
    cursor = current.length
  }

  /** Finish the current line and start a new empty one. */
  function endLine() {
    lines.push(current)
    linesBytes += currentBytes
    current = ''
    currentBytes = 0
    cursor = 0
    enforceBounds()
  }

  /**
   * Apply line-editing semantics to sanitized text.
   *
   * @param {string} text
   */
  function writeText(text) {
    let index = 0
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code === 0x0a) {
        endLine()
        index += 1
        continue
      }
      if (code === 0x0d) {
        cursor = 0
        index += 1
        continue
      }
      if (code === 0x08) {
        cursor = previousBoundary(current, cursor)
        index += 1
        continue
      }
      if (code === 0x09) {
        const spaces = TAB_WIDTH - (cursor % TAB_WIDTH)
        writeText(' '.repeat(spaces))
        index += 1
        continue
      }
      if (code === 0x1b) {
        // The sanitizer strips escapes; a lone ESC here is dropped defensively.
        index += 1
        continue
      }
      // Printable run up to the next control character.
      let end = index + 1
      while (end < text.length) {
        const next = text.charCodeAt(end)
        if (next === 0x0a || next === 0x0d || next === 0x08 || next === 0x09 || next === 0x1b) break
        end += 1
      }
      const run = text.slice(index, end)
      if (cursor >= current.length) appendRun(run)
      else for (const point of splitCodePoints(run)) putCodePoint(point)
      index = end
    }
    enforceBounds()
  }

  /**
   * Append one terminal output chunk.
   *
   * @param {string} text
   * @returns {string} the sanitized text that was applied (escape-free; may
   *   still contain `\n`, `\r`, `\b`, `\t`), useful for delta viewports
   */
  function append(text) {
    const sanitized = sanitizeChunk(sanitizer, text)
    if (sanitized.length === 0) return ''
    writeText(sanitized)
    return sanitized
  }

  /**
   * Read one newest-relative page of retained output.
   *
   * @param {{ offset?: number, count?: number, maxBytes?: number }} [options]
   * @returns {{ text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean }}
   */
  function snapshot(snapshotOptions = {}) {
    const offset = snapshotOptions.offset === undefined ? 0 : snapshotOptions.offset
    const count = snapshotOptions.count === undefined ? DEFAULT_SNAPSHOT_COUNT : snapshotOptions.count
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('scrollback snapshot: offset must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error('scrollback snapshot: count must be a positive safe integer')
    }
    const rawLimit = snapshotOptions.maxBytes
    const maxBytesLimit =
      rawLimit === undefined || rawLimit === null
        ? Infinity
        : Number.isFinite(Number(rawLimit))
          ? Math.max(0, Math.floor(Number(rawLimit)))
          : Infinity

    const retained = current.length > 0 ? [...lines.slice(head), current] : lines.slice(head)
    const totalLines = retained.length
    if (totalLines === 0) {
      return { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: dropped }
    }
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: dropped }
    }

    const end = totalLines - offset
    const start = Math.max(0, end - count)
    let text = retained.slice(start, end).join('\n')
    let cut = false
    if (Number.isFinite(maxBytesLimit) && Buffer.byteLength(text, 'utf8') > maxBytesLimit) {
      const bounded = utf8Tail(text, maxBytesLimit)
      text = bounded.text
      cut = bounded.truncated
    }
    const returnedLines = text.length === 0 ? 0 : text.split('\n').length
    return {
      text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: dropped || cut,
    }
  }

  /** Drop all retained output and sanitizer carry, keeping the bounds. */
  function clearContents() {
    lines = []
    head = 0
    linesBytes = 0
    current = ''
    currentBytes = 0
    cursor = 0
    dropped = false
    sanitizer.pending = ''
  }

  return {
    append,
    snapshot,
    clearContents,
    get totalLines() {
      return visibleCount()
    },
    get truncated() {
      return dropped
    },
    get bytes() {
      return retainedBytes()
    },
  }
}
