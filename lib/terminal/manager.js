/**
 * Owner-scoped registry of persistent remote PTY shell sessions.
 *
 * `createShellManager({ ctx, transport, config, logger })` owns every session it
 * opens: sessions are keyed by a manager-minted id (`remote-shell-<n>`) and
 * owned by the exact `Agent` object that opened them. Operations invoked with a
 * different agent fail with an Error whose `code` is `"FOREIGN_SESSION"`;
 * unknown ids fail with `"NO_SESSION"`. Disposal is quiescent (every close is
 * awaited) and the manager registers both an `agent/disposed` listener (close
 * that agent's sessions) and a `ctx.effect` teardown.
 *
 * ```js
 * const manager = createShellManager({ ctx, transport, config, logger })
 * const { sessionId, host, status, motd } = await manager.open({ agent, host: remoteHost })
 * const { viewport, waitReason, sessionStatus, truncated } = await manager.send({ agent, sessionId, text: "echo hi" })
 * await manager.close({ agent, sessionId })
 * ```
 *
 * Two surfaces share one registry:
 *
 * - **agent-facing** (`open/send/read/signal/close/describe/list`): every call
 *   is fenced by the exact `Agent` object that opened the session.
 * - **administrative** (`adminList/adminGet/adminRead/adminClose`): owner-agnostic
 *   read/list/close for the *local management UI* only (e.g. a host HTTP route
 *   that lists and can close live remote shells). The host route MUST fence
 *   browser requests itself; these methods are NOT for tools or agents, and
 *   `adminClose` can terminate any agent's session. Agent operations must always
 *   use the owner-fenced methods above.
 *
 * Host-policy decisions (allowHosts / readonly hosts / approval) belong to the
 * model-facing tool layer, which resolves a `RemoteHost` before calling
 * `open({ host })`. This module only needs `host.name` (for snapshots) and the
 * connection coordinates the transport understands.
 *
 * This module never imports `@deepseek-ai/*`.
 */

import { throwIfAborted } from '../ssh/errors.js'
import { createPtySession } from './pty-session.js'
import { runVerifiedPty } from './verified-exec.js'
import { randomBytes } from 'node:crypto'
import { targetConnectionDigest } from '../target-binding.js'

/** Prefix for manager-minted session ids. */
export const SESSION_ID_PREFIX = 'remote-shell-'
/** TERM value requested for every remote shell. */
export const DEFAULT_TERM = 'xterm-256color'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

/** @param {unknown} logger */
function makeLogger(logger) {
  const source = logger && typeof logger === 'object' ? /** @type {any} */ (logger) : {}
  const bind = (level) => (...args) => {
    const fn = source[level]
    if (typeof fn !== 'function') return
    try {
      fn.apply(source, args)
    } catch {
      // Logging must never break the manager.
    }
  }
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function managerError(message, code) {
  const error = /** @type {Error & { code: string }} */ (new Error(message))
  error.code = code
  return error
}

/** @param {unknown} agent */
function requireAgent(agent) {
  if (agent === undefined || agent === null || typeof agent !== 'object') {
    throw new TypeError('dsh-remote shell manager: an agent object is required')
  }
}

/** @param {any} agent @returns {string|null} */
function conversationIdOf(agent) {
  const session = agent?.session ?? agent
  const id = session?.id
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}

/**
 * Extract the disposed agent from an `agent/disposed` event. Cordis emits the
 * Agent itself; some hosts wrap it as `{ agent }`.
 *
 * @param {unknown} event
 * @returns {unknown}
 */
function agentOfEvent(event) {
  if (event && typeof event === 'object' && 'agent' in /** @type {any} */ (event)) {
    return /** @type {any} */ (event).agent
  }
  return event
}

/** POSIX single-quote a string for `/bin/sh`. @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Build a `cd` argument that keeps a leading `~` meaning the remote home
 * directory (quoted `~` would be literal).
 *
 * @param {string} remotePath
 * @returns {string}
 */
function cdArgument(remotePath) {
  const value = String(remotePath)
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return `"$HOME"/${shellQuote(value.slice(2))}`
  return shellQuote(value)
}

/**
 * Create the owner-scoped shell manager.
 *
 * @param {object} [deps]
 * @param {any} [deps.ctx] Cordis context (`on`/`effect`); optional in unit tests
 * @param {any} deps.transport SSH transport with `openPty(host, options)`
 * @param {object} [deps.config] normalized plugin config (`terminal*` fields)
 * @param {any} [deps.relay] canonical terminal relay with `acquireAgentPty()`
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @returns {{
 *   open(options: { agent: object, host: object, cwd?: string, name?: string, signal?: AbortSignal }): Promise<{
 *     sessionId: string, host: string, status: object, motd: string, sharedTerminal: boolean,
 *   }>,
 *   send(options: { agent: object, sessionId: string, text: string, submit?: boolean, signal?: AbortSignal, onData?: (event: { stream: "stdout", chunk: string }) => void }): Promise<{
 *     viewport: string, waitReason: string, sessionStatus: object, truncated: boolean,
 *   }>,
 *   read(options: { agent: object, sessionId: string, offset?: number, count?: number }): {
 *     text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean,
 *   },
 *   signal(options: { agent: object, sessionId: string, signal: string }): Promise<{ delivered: true, targetPgid: number }>,
 *   close(options: { agent: object, sessionId: string, reason?: string }): Promise<{ sessionId: string, closed: boolean }>,
 *   describe(agent: object, sessionId: string): { sessionId: string, host: string, status: object },
 *   list(agent: object): Array<{ sessionId: string, host: string, name?: string, status: object }>,
 *   adminList(): Array<{ sessionId: string, host: string, name?: string, status: object, createdAt: number }>,
 *   adminGet(sessionId: unknown): { sessionId: string, host: string, name?: string, status: object } | undefined,
 *   adminRead(options: { sessionId: string, offset?: number, count?: number }): {
 *     sessionId: string, host: string, text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean,
 *   },
 *   adminClose(options: { sessionId: string, reason?: string }): Promise<{ sessionId: string, closed: boolean }>,
 *   dispose(): Promise<void>,
 *   readonly size: number,
 *   readonly isDisposed: boolean,
 * }}
 */
export function createShellManager({ ctx, transport, config, relay, logger } = {}) {
  if (!transport || typeof transport !== 'object') {
    throw new TypeError('createShellManager: an SSH transport is required')
  }
  const log = makeLogger(logger)
  const sharedRelay = relay && typeof relay.acquireAgentPty === 'function' ? relay : null
  const cols = positiveInt(config?.terminalCols, DEFAULT_COLS)
  const rows = positiveInt(config?.terminalRows, DEFAULT_ROWS)

  /** @type {Map<string, { id: string, agent: any, host: any, hostName: string, session: any, name?: string, createdAt: number, sharedTerminal: boolean }>} */
  const sessions = new Map()
  /** @type {Map<any, Map<string, Promise<any>>>} Open one canonical PTY per exact Agent and host. */
  const pendingOpens = new Map()
  /** Agents that have emitted `agent/disposed`; they may not publish new shells. */
  const disposedAgents = new WeakSet()
  let counter = 0
  let disposed = false
  /** @type {Promise<void>|null} */
  let disposePromise = null
  /** @type {null | (() => void)} */
  let detachAgentDisposed = null

  /**
   * Resolve one live session by id without ownership fencing. Only the
   * administrative surface may use this; agent-facing operations go through
   * {@link resolve}, which also checks the exact owning Agent.
   *
   * @param {string} sessionId
   * @returns {{ id: string, agent: any, host: any, hostName: string, session: any, name?: string, createdAt: number }}
   */
  function entryById(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new TypeError('dsh-remote shell manager: a non-empty sessionId is required')
    }
    const entry = sessions.get(sessionId)
    if (entry === undefined) {
      throw managerError(`unknown remote shell session ${JSON.stringify(sessionId)}`, 'NO_SESSION')
    }
    return entry
  }

  /**
   * Owner-agnostic snapshot of one live session (administrative surface only).
   * Never exposes the owning Agent.
   *
   * @param {{ id: string, hostName: string, session: any, name?: string }} entry
   * @returns {{ sessionId: string, host: string, name?: string, status: object }}
   */
  function adminSnapshot(entry) {
    return {
      sessionId: entry.id,
      host: entry.hostName,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      status: entry.session.status(),
      ownerSessionId: entry.agent?.session?.id ?? entry.agent?.id ?? null,
    }
  }

  /**
   * Resolve one session with exact-agent ownership fencing.
   *
   * @param {any} agent
   * @param {string} sessionId
   * @returns {{ id: string, agent: any, host: any, hostName: string, session: any, name?: string, createdAt: number }}
   */
  function resolve(agent, sessionId) {
    requireAgent(agent)
    const entry = entryById(sessionId)
    if (entry.agent !== agent) {
      throw managerError(
        `remote shell session ${JSON.stringify(sessionId)} belongs to another agent`,
        'FOREIGN_SESSION',
      )
    }
    return entry
  }

  /**
   * Close one registry entry and await quiescence. Best-effort: the entry is
   * removed from the registry first and a close failure is logged, never thrown.
   *
   * @param {{ id: string, session: any }} entry
   * @param {string|undefined} reason
   * @returns {Promise<{ sessionId: string, closed: boolean }>}
   */
  async function closeEntry(entry, reason, releaseShared = false) {
    if (releaseShared && entry.sharedTerminal && typeof entry.pty.release !== 'function') {
      throw managerError('Shared PTY release is unavailable; refusing to close the user terminal', 'SHARED_PTY_RELEASE_UNAVAILABLE')
    }
    sessions.delete(entry.id)
    let sharedTerminalPreserved = false
    try {
      // The relay, not this Agent handle, owns a user-visible shared SSH PTY.
      // Release BEFORE closing the facade so routine cleanup cannot kill it.
      if (releaseShared && entry.sharedTerminal && typeof entry.pty.release === 'function') {
        sharedTerminalPreserved = entry.pty.status()?.kind === 'running'
        entry.pty.release()
      }
      entry.verifiedLease?.cancel()
      await entry.session.close(reason === undefined ? 'closed' : String(reason), { sharedTerminalPreserved })
    } catch (error) {
      // Close is best-effort: a dead channel must not strand the registry.
      log.warn?.(
        `[dsh-remote] closing remote shell ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { sessionId: entry.id, closed: true, ...(sharedTerminalPreserved ? { sharedTerminalPreserved: true } : {}) }
  }

  /**
   * Close one session as its owning agent (exact-agent fencing).
   *
   * @param {{ agent: any, sessionId: string, reason?: string }} request
   * @returns {Promise<{ sessionId: string, closed: boolean }>}
   */
  async function close({ agent, sessionId, reason } = {}) {
    return closeEntry(resolve(agent, sessionId), reason, true)
  }

  /**
   * Close every session owned by one agent (used by `agent/disposed`).
   *
   * @param {any} agent
   */
  async function closeAgentSessions(agent) {
    if (agent === undefined || agent === null) return
    if ((typeof agent !== 'object' && typeof agent !== 'function')) return
    disposedAgents.add(agent)
    const opening = [...(pendingOpens.get(agent)?.values() ?? [])]
    if (opening.length > 0) await Promise.allSettled(opening)
    const entries = [...sessions.values()].filter((entry) => entry.agent === agent)
    if (entries.length === 0) return
    await Promise.allSettled(
      entries.map((entry) => closeEntry(entry, 'agent disposed', true)),
    )
  }

  if (ctx && typeof ctx.on === 'function') {
    try {
      const detach = ctx.on('agent/disposed', (event) => {
        void closeAgentSessions(agentOfEvent(event))
      })
      if (typeof detach === 'function') detachAgentDisposed = detach
    } catch (error) {
      log.warn?.(
        `[dsh-remote] shell manager could not subscribe to agent/disposed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => dispose(), 'dsh-remote: remote shell manager')
    } catch (error) {
      log.warn?.(
        `[dsh-remote] shell manager could not register its effect teardown: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Return the one live PTY this Agent already owns for the host, otherwise
   * coalesce concurrent opens before creating a new canonical session.
   *
   * When the native terminal relay is enabled, it owns the underlying SSH PTY;
   * the Agent manager borrows that exact channel. Opening from either surface
   * first therefore still converges on one session.
   *
   * @param {{ agent: any, host: any, cwd?: string, name?: string, signal?: AbortSignal }} request
   * @returns {Promise<{ sessionId: string, host: string, status: object, motd: string, sharedTerminal: boolean }>}
   */
  function waitForOpen(promise, signal) {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(managerError('remote shell open cancelled', 'CANCELLED')) }
      const cleanup = () => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
      if (signal.aborted) abort()
    })
  }

  function open(request = {}) {
    throwIfAborted(request.signal)
    if (disposed) return Promise.reject(managerError('the remote shell manager has been disposed', 'DISPOSED'))
    const agent = request.agent
    requireAgent(agent)
    if (disposedAgents.has(agent)) return Promise.reject(managerError('the owning Agent has been disposed', 'DISPOSED'))
    const host = request.host
    const hostName = typeof host?.name === 'string' && host.name.length > 0 ? host.name : host?.host
    if (typeof hostName !== 'string' || hostName.length === 0) {
      return Promise.reject(new TypeError('dsh-remote shell manager: a resolved host object is required'))
    }
    for (const entry of sessions.values()) {
      if (entry.agent !== agent || entry.hostName !== hostName || entry.session.status()?.kind === 'exited') continue
      return Promise.resolve({
        sessionId: entry.id,
        host: entry.hostName,
        status: entry.session.status(),
        motd: entry.session.motd,
        sharedTerminal: entry.sharedTerminal,
      })
    }
    let byHost = pendingOpens.get(agent)
    if (!byHost) pendingOpens.set(agent, (byHost = new Map()))
    const pending = byHost.get(hostName)
    if (pending) return waitForOpen(pending, request.signal)
    const operation = openOne(request)
    byHost.set(hostName, operation)
    return operation.finally(() => {
      if (byHost.get(hostName) === operation) byHost.delete(hostName)
      if (byHost.size === 0) pendingOpens.delete(agent)
    })
  }

  /** @param {{ agent: any, host: any, cwd?: string, name?: string, signal?: AbortSignal }} request */
  async function openOne({ agent, host, cwd, name, signal } = {}) {
    if (disposed) throw managerError('the remote shell manager has been disposed', 'DISPOSED')
    requireAgent(agent)
    if (!host || typeof host !== 'object' || typeof host.host !== 'string' || host.host.length === 0) {
      throw new TypeError('dsh-remote shell manager: a resolved host object is required')
    }
    if (typeof transport.openPty !== 'function') {
      throw new Error('dsh-remote shell manager: this transport does not support PTY sessions (openPty is unavailable)')
    }
    throwIfAborted(signal)

    const hostName = typeof host.name === 'string' && host.name.length > 0 ? host.name : host.host
    /** @type {any} */
    let pty = null
    /** @type {any} */
    let session = null
    let initialOutput = ''
    let sharedTerminal = false
    let reusedTerminal = false
    try {
      const conversationId = conversationIdOf(agent)
      if (sharedRelay !== null && conversationId !== null) {
        const acquired = await sharedRelay.acquireAgentPty({
          hostName,
          sessionId: conversationId,
          cols,
          rows,
          ...(signal ? { signal } : {}),
        })
        reusedTerminal = acquired.reused === true
        pty = acquired.pty
        initialOutput = acquired.initialOutput
        sharedTerminal = true
      } else {
        if (host.viaHost) throw managerError('Cluster shortcuts require the shared native terminal relay; refusing to open an entry-host shell as the cluster', 'SHARED_PTY_REQUIRED')
        pty = await transport.openPty(host, {
          term: DEFAULT_TERM,
          cols,
          rows,
          ...(signal ? { signal } : {}),
        })
      }
      session = createPtySession({ pty, config, initialOutput, logger: log })
      const started = await session.start(signal ? { signal } : {})
      if (cwd !== undefined && cwd !== null && String(cwd).trim().length > 0) {
        const change = session.startSend({
          text: `cd ${cdArgument(String(cwd))}`,
          submit: true,
          ...(signal ? { signal } : {}),
        })
        const result = await change.done
        if (result.sessionStatus && result.sessionStatus.kind === 'exited') {
          throw managerError(
            `remote shell on ${hostName} exited while entering ${JSON.stringify(String(cwd))}`,
            'SESSION_EXIT',
          )
        }
      }
      throwIfAborted(signal)
      if (disposed || disposedAgents.has(agent)) {
        throw managerError(disposed ? 'the remote shell manager has been disposed' : 'the owning Agent has been disposed', 'DISPOSED')
      }
      const id = `${SESSION_ID_PREFIX}${(counter += 1)}`
      sessions.set(id, {
        id,
        agent,
        host,
        hostName,
        session,
        pty,
        verifiedLease: null,
        connectionDigest: pty.connectionDigest ?? targetConnectionDigest(host),
        ...(name === undefined ? {} : { name: String(name) }),
        createdAt: Date.now(),
        sharedTerminal,
      })
      return { sessionId: id, host: hostName, status: session.status(), motd: started.motd, sharedTerminal }
    } catch (error) {
      // Failure to adopt an existing human PTY must not tear that PTY down.
      if (sharedTerminal && reusedTerminal) pty?.release?.()
      if (session !== null) {
        try {
          await session.close('open failed')
        } catch {
          // ignore: the original error is what matters
        }
      } else if (pty !== null) {
        try {
          await pty.close('open failed')
        } catch {
          // ignore
        }
      }
      throw error
    }
  }

  /**
   * Send text to a session and wait for it to settle.
   *
   * `onData`, when provided, is forwarded to the session's send: it receives
   * every non-empty sanitized output chunk the send appends to scrollback as
   * `{ stream: "stdout", chunk }`. It is never called after the send settles and
   * callback exceptions are swallowed there (used by the v0.4 live terminal
   * mirror).
   *
   * @param {{ agent: any, sessionId: string, text: string, submit?: boolean, signal?: AbortSignal, onData?: (event: { stream: "stdout", chunk: string }) => void }} request
   * @returns {Promise<{ viewport: string, waitReason: string, sessionStatus: object, truncated: boolean }>}
   */
  async function send({ agent, sessionId, text, submit, signal, onData } = {}) {
    const entry = resolve(agent, sessionId)
    if (entry.verifiedLease) throw managerError('Session held by a verified operation', 'VERIFIED_LEASE_BUSY')
    entry.verifiedReady = false
    const operation = entry.session.startSend({
      text: text === undefined || text === null ? '' : String(text),
      submit: submit !== false,
      ...(signal ? { signal } : {}),
      ...(onData === undefined ? {} : { onData }),
    })
    return operation.done
  }

  /** Hold exact Agent/channel identity through probe, approval, and guarded action. */
  async function withVerifiedLease({ agent, sessionId, signal, resetInput = false } = {}, fn) {
    const entry = resolve(agent, sessionId)
    throwIfAborted(signal)
    if (typeof fn !== 'function') throw new TypeError('Verified lease requires a callback')
    if (entry.verifiedLease || entry.session.isSending) throw managerError('PTY has another active operation', 'VERIFIED_LEASE_BUSY')
    if (entry.session.status().kind !== 'running') throw managerError('PTY is not running', 'VERIFIED_LEASE_INVALID')
    const controller = new AbortController()
    const cancel = () => { entry.verifiedReady = false; controller.abort(managerError('Verified channel proof invalidated', 'VERIFIED_LEASE_INVALID')) }
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const lease = { cancel }
    entry.verifiedLease = lease
    let channelLease
    let detachExit
    const assertCurrent = () => {
      throwIfAborted(controller.signal)
      if (resolve(agent, sessionId) !== entry || entry.verifiedLease !== lease || entry.session.status().kind !== 'running' || channelLease?.valid() === false) throw managerError('Verified PTY is no longer current', 'VERIFIED_LEASE_INVALID')
    }
    try {
      if (typeof entry.pty.beginVerifiedLease === 'function') channelLease = entry.pty.beginVerifiedLease(cancel)
      else detachExit = entry.pty.onExit(cancel)
      assertCurrent()
      const ready = () => channelLease ? channelLease.ready() : entry.verifiedReady === true
      const setReady = value => { entry.verifiedReady = value; channelLease?.setReady(value) }
      const context = { signal: controller.signal, send: async (command, options = {}) => {
        assertCurrent()
        setReady(false)
        const linkedSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
        try {
          const operation = entry.session.startSend({ ...options, text: command, submit: true, signal: linkedSignal })
          const result = await operation.done
          assertCurrent()
          setReady(result.waitReason === 'protocol_complete' && result.truncated !== true)
          return result
        } catch (error) { setReady(false); throw error }
      } }
      if (!ready()) {
        if (resetInput !== true) throw managerError('Unknown PTY input state requires an explicitly approved reset', 'CONTEXT_RESET_REQUIRED')
        // Only the tool's separately approved reset path may interrupt/clear input.
        entry.pty.write('\u0003\u0015')
        const nonce = randomBytes(16).toString('hex')
        const marker = `DSH_READY_${nonce}`
        const script = `dsh_ready_${nonce}() { printf '\\n%s%s\\n' 'DSH_READY_' '${nonce}'; }; dsh_ready_${nonce}; unset -f dsh_ready_${nonce}`
        const proof = await runVerifiedPty({ send: context.send, command: script, signal: controller.signal, timeoutMs: 5000, maxBytes: 16384,
          isComplete: output => output.split(/\r?\n/u).filter(line => line === marker).length === 1 })
        if (!proof.complete) { setReady(false); throw managerError('PTY shell readiness could not be proven', 'CONTEXT_RESET_FAILED') }
      }
      const value = await fn(context)
      assertCurrent()
      return value
    } catch (error) {
      entry.verifiedReady = false
      channelLease?.setReady(false)
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      detachExit?.()
      channelLease?.release()
      if (entry.verifiedLease === lease) entry.verifiedLease = null
    }
  }

  /**
   * Read one newest-relative scrollback page (synchronous, no side effects).
   *
   * @param {{ agent: any, sessionId: string, offset?: number, count?: number }} request
   */
  function read({ agent, sessionId, offset, count } = {}) {
    const entry = resolve(agent, sessionId)
    return entry.session.read({ offset, count })
  }

  /**
   * Deliver one signal to the session's foreground process group.
   *
   * @param {{ agent: any, sessionId: string, signal: string }} request
   * @returns {Promise<{ delivered: true, targetPgid: number }>}
   */
  async function signal({ agent, sessionId, signal } = {}) {
    const entry = resolve(agent, sessionId)
    entry.verifiedReady = false
    entry.verifiedLease?.cancel()
    return entry.session.signal(signal)
  }

  /**
   * Owner-visible session snapshot without any side effects.
   *
   * @param {any} agent
   * @param {string} sessionId
   * @returns {{ sessionId: string, host: string, status: object }}
   */
  function describe(agent, sessionId) {
    const entry = resolve(agent, sessionId)
    return { sessionId: entry.id, host: entry.hostName, status: entry.session.status(), connectionDigest: entry.connectionDigest }
  }

  /**
   * List the sessions owned by exactly this agent.
   *
   * @param {any} agent
   * @returns {Array<{ sessionId: string, host: string, name?: string, status: object }>}
   */
  function list(agent) {
    requireAgent(agent)
    const snapshots = []
    for (const entry of sessions.values()) {
      if (entry.agent !== agent) continue
      snapshots.push(adminSnapshot(entry))
    }
    return snapshots
  }

  /* ---------------------------------------------------------------------- */
  /* Administrative surface — local management UI only, NOT for agents.     */
  /* The host route that exposes these over HTTP must fence browser access. */
  /* ---------------------------------------------------------------------- */

  /**
   * List every live session regardless of owner, in publication order.
   * Administrative surface for the local management UI only — not for
   * tools/agents. Browser requests reaching a host route must be fenced there.
   *
   * @returns {Array<{ sessionId: string, host: string, name?: string, status: object, createdAt: number }>}
   */
  function adminList() {
    return [...sessions.values()].map((entry) => ({ ...adminSnapshot(entry), createdAt: entry.createdAt }))
  }

  /**
   * Snapshot one live session regardless of owner, or `undefined` when the id is
   * unknown/invalid (never throws). Administrative surface for the local
   * management UI only — not for tools/agents.
   *
   * @param {unknown} sessionId
   * @returns {{ sessionId: string, host: string, name?: string, status: object } | undefined}
   */
  function adminGet(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
    const entry = sessions.get(sessionId)
    if (entry === undefined) return undefined
    return adminSnapshot(entry)
  }

  /**
   * Read one newest-relative scrollback page regardless of owner. Same page
   * mapping as {@link read}, but without agent fencing; throws an Error with
   * `code === "NO_SESSION"` when the id is unknown. Administrative surface for
   * the local management UI only — not for tools/agents.
   *
   * @param {{ sessionId: string, offset?: number, count?: number }} request
   * @returns {{ sessionId: string, host: string, text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean }}
   */
  function adminRead({ sessionId, offset, count } = {}) {
    const entry = entryById(sessionId)
    const page = entry.session.read({ offset, count })
    return { sessionId: entry.id, host: entry.hostName, ...page }
  }

  /**
   * Close one session regardless of owner and await quiescence, exactly like
   * {@link close} but without agent fencing; throws an Error with
   * `code === "NO_SESSION"` when the id is unknown. Administrative surface for
   * the local management UI only — it can terminate another agent's session;
   * tools/agents must keep using the owner-fenced methods.
   *
   * @param {{ sessionId: string, reason?: string }} request
   * @returns {Promise<{ sessionId: string, closed: boolean }>}
   */
  async function adminClose({ sessionId, reason } = {}) {
    return closeEntry(entryById(sessionId), reason)
  }

  /**
   * Close every session and await quiescence. Idempotent; later `open` calls
   * reject with `code === "DISPOSED"`.
   *
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposePromise) return disposePromise
    if (disposed) return Promise.resolve()
    disposed = true
    if (detachAgentDisposed) {
      try {
        detachAgentDisposed()
      } catch {
        // ignore
      }
      detachAgentDisposed = null
    }
    const entries = [...sessions.values()]
    const opening = [...pendingOpens.values()].flatMap((byHost) => [...byHost.values()])
    sessions.clear()
    const closing = entries.map((entry) => closeEntry(entry, 'plugin disposed', true))
    disposePromise = Promise.allSettled([...closing, ...opening]).then(() => undefined)
    return disposePromise
  }

  return {
    open,
    send,
    withVerifiedLease,
    read,
    signal,
    close,
    describe,
    list,
    // Administrative surface for the local management UI only (NOT for agents):
    // the host HTTP route must fence browser requests itself.
    adminList,
    adminGet,
    adminRead,
    adminClose,
    dispose,
    get size() {
      return sessions.size
    },
    get isDisposed() {
      return disposed
    },
  }
}
