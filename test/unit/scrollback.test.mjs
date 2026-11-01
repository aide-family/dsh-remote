/**
 * Unit tests for lib/terminal/scrollback.js — the streaming sanitizer and
 * bounded newest-relative line ring.
 *
 * Pure: no DSH imports, no I/O, no timers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_MAX_LINES,
  TAB_WIDTH,
  createSanitizerState,
  createScrollback,
  flushSanitizer,
  sanitizeChunk,
  utf8Tail,
} from '../../lib/terminal/scrollback.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {Array<string|number>} lines */
function joined(lines) {
  return `${lines.join('\n')}`
}

/** Snapshot every retained line (newest-relative offset 0). */
function full(sb, extra = {}) {
  return sb.snapshot({ offset: 0, count: 10_000, ...extra })
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

test('sanitizer: strips CSI colour/erase sequences', () => {
  const sb = createScrollback()
  sb.append('\x1b[31mred\x1b[0m \x1b[1;32mbold-green\x1b[0m\x1b[2J\n')
  assert.equal(full(sb).text, 'red bold-green')
})

test('sanitizer: strips OSC sequences terminated by BEL and by ST', () => {
  const sb = createScrollback()
  sb.append('\x1b]0;window title\x07visible\n')
  sb.append('\x1b]2;another\x1b\\after-st\n')
  assert.equal(full(sb).text, 'visible\nafter-st')
})

test('sanitizer: strips DCS/SOS/PM/APC control strings and short ESC sequences', () => {
  const sb = createScrollback()
  sb.append('\x1bP1$r0;1m\x1b\\dcs-done\n')
  sb.append('\x1b(Bcharset\n')
  sb.append('\x1b7saved\x1b8\n')
  sb.append('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\n')
  assert.equal(full(sb).text, 'dcs-done\ncharset\nsaved\nlink')
})

test('sanitizer: keeps an incomplete escape sequence across chunk boundaries', () => {
  const sb = createScrollback()
  assert.equal(sb.append('ok \x1b[3'), 'ok ')
  assert.equal(sb.append('1mred'), 'red')
  assert.equal(sb.append('\n'), '\n')
  assert.equal(full(sb).text, 'ok red')
})

test('sanitizer: carries an incomplete OSC string across chunk boundaries', () => {
  const sb = createScrollback()
  sb.append('\x1b]0;ti')
  sb.append('tle\x07body\n')
  assert.equal(full(sb).text, 'body')
})

test('sanitizer: drops other C0 control characters and DEL', () => {
  const sb = createScrollback()
  sb.append('a\u0000b\u0007c\u000ed\u007fe\n')
  assert.equal(full(sb).text, 'abcde')
})

test('sanitizer: direct sanitizeChunk state is reusable and flush discards partials', () => {
  const state = createSanitizerState()
  assert.equal(sanitizeChunk(state, '\x1b[31mhi'), 'hi')
  assert.equal(sanitizeChunk(state, '\x1b[0m!'), '!')
  assert.equal(sanitizeChunk(state, '\x1b]0;x'), '')
  assert.equal(state.pending.startsWith('\x1b'), true)
  assert.equal(flushSanitizer(state), '')
  assert.equal(state.pending, '')
})

// ---------------------------------------------------------------------------
// Line editing
// ---------------------------------------------------------------------------

test('lines: newline terminates the current line and retains a partial line', () => {
  const sb = createScrollback()
  sb.append('one\ntwo')
  assert.equal(sb.totalLines, 2)
  assert.deepEqual(full(sb), { text: 'one\ntwo', totalLines: 2, lineBegin: 0, lineEnd: 2, truncated: false })
  sb.append(' three')
  assert.equal(full(sb).text, 'one\ntwo three')
})

test('lines: \r\n ends a line and empty lines are retained', () => {
  const sb = createScrollback()
  sb.append('a\r\n\r\nb\r\n')
  assert.equal(sb.totalLines, 3)
  assert.equal(full(sb).text, 'a\n\nb')
})

test('lines: a trailing newline does not add a phantom empty line', () => {
  const sb = createScrollback()
  sb.append('a\n')
  assert.equal(sb.totalLines, 1)
  assert.equal(full(sb).text, 'a')
})

test('lines: \r rewrites the line from column 0', () => {
  const sb = createScrollback()
  sb.append('progress 10%\rprogress 100%\n')
  assert.equal(full(sb).text, 'progress 100%')
})

test('lines: \r overwrites only the characters written after it', () => {
  const sb = createScrollback()
  sb.append('abc\rX\n')
  assert.equal(full(sb).text, 'Xbc')
})

test('lines: a truncated \r rewrite keeps the tail of the previous content', () => {
  const sb = createScrollback()
  sb.append('long line\rshort\n')
  assert.equal(full(sb).text, 'shortline')
})

test('lines: \r at a chunk boundary still rewrites (CRLF split)', () => {
  const sb = createScrollback()
  sb.append('a\r')
  sb.append('\nb\r\n')
  assert.equal(full(sb).text, 'a\nb')
})

test('lines: backspace moves the cursor and the next text overwrites', () => {
  const sb = createScrollback()
  sb.append('abcd\b\bXY\n')
  assert.equal(full(sb).text, 'abXY')
})

test('lines: backspace never moves before the start of the line', () => {
  const sb = createScrollback()
  sb.append('\b\bX\n')
  assert.equal(full(sb).text, 'X')
})

test('lines: tab advances to the next 8-column tab stop', () => {
  const sb = createScrollback()
  sb.append('a\tb\n')
  assert.equal(TAB_WIDTH, 8)
  assert.equal(full(sb).text, `a${' '.repeat(7)}b`)
})

test('lines: tab at a tab stop advances a full tab width', () => {
  const sb = createScrollback()
  sb.append('12345678\tX\n')
  assert.equal(full(sb).text, `12345678${' '.repeat(8)}X`)
})

// ---------------------------------------------------------------------------
// UTF-8 / code-point safety
// ---------------------------------------------------------------------------

test('utf8: multi-byte text survives unchanged', () => {
  const sb = createScrollback()
  sb.append('héllo wörld\n世界 ok\n')
  assert.equal(sb.totalLines, 2)
  assert.equal(full(sb).text, 'héllo wörld\n世界 ok')
})

test('utf8: a surrogate pair split across chunks is joined, not mojibake', () => {
  const sb = createScrollback()
  sb.append('\ud83d')
  sb.append('\ude00!\n')
  assert.equal(full(sb).text, '😀!')
})

test('utf8: backspace treats an astral code point as one column', () => {
  const sb = createScrollback()
  sb.append('😀x\b\bY\n')
  assert.equal(full(sb).text, 'Yx')
})

test('utf8: snapshot maxBytes cuts on a code-point boundary (never a replacement char)', () => {
  const sb = createScrollback()
  sb.append('aaaa\n世界\n')
  const page = full(sb, { maxBytes: 4 })
  assert.equal(page.truncated, true)
  assert.equal(page.text.includes('\ufffd'), false)
  assert.equal(Buffer.byteLength(page.text, 'utf8') <= 4, true)
  // Tail kept: the newest line is "世界" minus a split code point.
  assert.equal(page.text, '界')
})

test('utf8Tail: keeps the tail within the byte budget', () => {
  assert.deepEqual(utf8Tail('abcdef', 3), { text: 'def', truncated: true })
  assert.deepEqual(utf8Tail('abc', 3), { text: 'abc', truncated: false })
  assert.deepEqual(utf8Tail('世界', 3), { text: '界', truncated: true })
  assert.deepEqual(utf8Tail('世界', 0), { text: '', truncated: true })
  assert.deepEqual(utf8Tail('', 0), { text: '', truncated: false })
})

// ---------------------------------------------------------------------------
// Bounds, truncation, eviction
// ---------------------------------------------------------------------------

test('bounds: line ring keeps the newest lines and flags truncation', () => {
  const sb = createScrollback({ maxLines: 3 })
  sb.append('1\n2\n3\n4\n5')
  assert.equal(sb.totalLines, 3)
  assert.equal(sb.truncated, true)
  assert.equal(full(sb).text, '3\n4\n5')
})

test('bounds: byte ring drops the oldest lines first', () => {
  const sb = createScrollback({ maxLines: 100, maxBytes: 10 })
  sb.append('aaaa\nbbbb\ncccc\n')
  assert.equal(sb.truncated, true)
  assert.equal(full(sb).text, 'bbbb\ncccc')
  assert.equal(sb.bytes <= 10, true)
})

test('bounds: a single overlong line is trimmed to half the byte budget', () => {
  const sb = createScrollback({ maxLines: 100, maxBytes: 64 })
  sb.append('x'.repeat(1_000))
  const page = full(sb)
  assert.equal(sb.truncated, true)
  assert.equal(Buffer.byteLength(page.text, 'utf8') <= 32, true)
  assert.equal(page.text.startsWith('x'), true)
})

test('bounds: default bounds are applied when options are missing/invalid', () => {
  const sb = createScrollback({ maxLines: 0, maxBytes: -1 })
  assert.equal(DEFAULT_MAX_LINES, 2_000)
  for (let index = 0; index < 2_100; index += 1) sb.append(`line-${index}\n`)
  assert.equal(sb.totalLines, 2_000)
  assert.equal(sb.truncated, true)
  const page = sb.snapshot({ offset: 0, count: 1 })
  assert.equal(page.text, 'line-2099')
})

test('bounds: clearContents resets lines, bounds state and sanitizer carry', () => {
  const sb = createScrollback()
  sb.append('\x1b[31mhello')
  assert.equal(sb.totalLines, 1)
  sb.clearContents()
  assert.equal(sb.totalLines, 0)
  assert.equal(sb.truncated, false)
  assert.deepEqual(full(sb), { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false })
  sb.append('fresh\n')
  assert.equal(full(sb).text, 'fresh')
})

// ---------------------------------------------------------------------------
// Snapshot pagination
// ---------------------------------------------------------------------------

test('snapshot: newest-relative offset/count pages walk backwards', () => {
  const sb = createScrollback()
  sb.append(joined([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) + '\n')
  assert.equal(sb.totalLines, 10)

  const newest = sb.snapshot({ offset: 0, count: 3 })
  assert.deepEqual(newest, { text: '7\n8\n9', totalLines: 10, lineBegin: 0, lineEnd: 3, truncated: false })

  const older = sb.snapshot({ offset: 3, count: 3 })
  assert.deepEqual(older, { text: '4\n5\n6', totalLines: 10, lineBegin: 3, lineEnd: 6, truncated: false })

  const oldest = sb.snapshot({ offset: 7, count: 10 })
  assert.deepEqual(oldest, { text: '0\n1\n2', totalLines: 10, lineBegin: 7, lineEnd: 10, truncated: false })
})

test('snapshot: defaults return the whole retained scrollback', () => {
  const sb = createScrollback()
  sb.append('a\nb\nc')
  const page = sb.snapshot()
  assert.equal(page.text, 'a\nb\nc')
  assert.equal(page.totalLines, 3)
  assert.equal(page.lineBegin, 0)
  assert.equal(page.lineEnd, 3)
})

test('snapshot: an offset past the retained lines returns an empty page at that offset', () => {
  const sb = createScrollback()
  sb.append('a\nb\n')
  const page = sb.snapshot({ offset: 5, count: 2 })
  assert.deepEqual(page, { text: '', totalLines: 2, lineBegin: 5, lineEnd: 5, truncated: false })
})

test('snapshot: maxBytes cuts the page and reports truncation', () => {
  const sb = createScrollback()
  sb.append('aaaa\nbbbb\ncccc\ndddd\neeee\n')
  const page = sb.snapshot({ offset: 0, count: 5, maxBytes: 4 })
  assert.equal(page.text, 'eeee')
  assert.equal(page.totalLines, 5)
  assert.equal(page.lineBegin, 0)
  assert.equal(page.lineEnd, 1)
  assert.equal(page.truncated, true)
})

test('snapshot: truncated flag reflects evicted history even when the page fits', () => {
  const sb = createScrollback({ maxLines: 2 })
  sb.append('old1\nold2\nnew1\nnew2\n')
  const page = sb.snapshot({ offset: 0, count: 2 })
  assert.deepEqual(page, { text: 'new1\nnew2', totalLines: 2, lineBegin: 0, lineEnd: 2, truncated: true })
})

test('snapshot: invalid offset/count are rejected', () => {
  const sb = createScrollback()
  sb.append('a\n')
  assert.throws(() => sb.snapshot({ offset: -1 }), /offset/)
  assert.throws(() => sb.snapshot({ offset: 1.5 }), /offset/)
  assert.throws(() => sb.snapshot({ offset: 0, count: 0 }), /count/)
  assert.throws(() => sb.snapshot({ offset: 0, count: Number.NaN }), /count/)
})

test('snapshot: empty scrollback is a clean empty page', () => {
  const sb = createScrollback()
  assert.deepEqual(sb.snapshot(), { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false })
  assert.equal(sb.totalLines, 0)
})
