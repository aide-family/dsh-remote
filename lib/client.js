/**
 * dsh-remote browser half.
 *
 * Two surfaces share this one client bundle:
 *
 * 1. The "Remote Ops" management page (v0.3) — a first-level sidebar panel
 *    (`sidebar.panellist` id `dsh-remote`) and its keyed `main` page, reading the
 *    Host HTTP API at `/dsh-remote/api`.
 * 2. The "Remote Terminal" right-sidebar tab (v0.4) — a right Sidebar tab type
 *    (`dsh-remote-live`) whose body mirrors the agent's live remote commands:
 *    it subscribes to the Host SSE stream `/dsh-remote/live`, replays the
 *    snapshot, appends `start`/`output`/`end`/`clear` frames as terminal lines,
 *    and the plugin auto-opens the tab on the first live command of the current
 *    session when the Host overview reports `live.autoOpen`.
 *
 * Hand-written bundle in the DSH client module-loader format: the loader runs
 * this file, registers the factory, and materializes it lazily. The factory
 * returns a Cordis client plugin (`{ name, inject, apply }`). Only
 * `require("react")` is used (platform baseline module); there is no build step.
 */
window.__ModuleLoader__.load({
  id: "@aide-family/dsh-remote",
  factory: function factory(require) {
    try {
    const React = require("react");
    const h = React.createElement;

    const API_URL = "/dsh-remote/api";
    const LIVE_URL = "/dsh-remote/live";
    const STYLE_ID = "dsh-remote/ops.css";
    const LIVE_STYLE_ID = "dsh-remote/live.css";
    const PANEL_ID = "dsh-remote";
    /** Right-Sidebar tab type id — also the body/title slot key. */
    const LIVE_TAB_ID = "dsh-remote-live";
    const LIVE_TITLE = "远程终端";
    const LIVE_GUIDE_DESCRIPTION = "实时显示 agent 执行的远端命令";
    const REFRESH_MS = 10_000;
    /** v0.5.1: the Recent Operations card always shows exactly the newest 20. */
    const RECENT_AUDIT_LABEL = "最近 20 条操作";
    /** v0.5.1: the full-detail audit export reads the retained trail in one page. */
    const AUDIT_EXPORT_LIMIT = 500;
    /** Client-side scrollback bounds for the live terminal mirror. */
    const LIVE_MAX_COMMANDS = 200;
    const LIVE_MAX_COMMAND_OUTPUT = 120_000;
    const LIVE_MAX_TOTAL_OUTPUT = 600_000;
    const LIVE_SCROLL_SLACK = 24;
    const LIVE_NOTIFY_MS = 40;

    // ---------------------------------------------------------------------
    // v0.5 runtime services: native terminal opener + conversation handoff
    //
    // The root client context is captured in apply() and every optional service
    // is feature-detected at call time, so the management page and the v0.4 live
    // mirror keep working in a composition that has no terminal/session UI.
    // ---------------------------------------------------------------------

    /** Root client context captured by `apply()` (see the plugin object below). */
    let runtimeCtx = null;
    /** Services captured through optional nested `ctx.inject(...)` calls. */
    let runtimeRight = null;
    let runtimeTerminals = null;
    let runtimeSessions = null;
    let runtimeUiSession = null;
    let runtimeUiWorkspace = null;
    let nativeOpenSequence = 0;

    /** DSH-native terminal opening bounds (docs/ARCHITECTURE.md, browser half). */
    const TERMINAL_TAB_WAIT_MS = 5_000;
    const TERMINAL_WRITABLE_WAIT_MS = 20_000;
    const CONVERSATION_WAIT_MS = 3_000;
    const WAIT_POLL_MS = 100;

    /**
     * v0.5.2: 连接 opens a NEW conversation first, then attaches the default
     * terminal in it. `startSession()` has no return contract, so poll
     * `uiSession.current` + `sidebarRight.mounted` for up to 8s (250ms poll).
     * Wait for the target session's right-sidebar store to be adopted before
     * opening exactly one terminal. Tab ids are local to each session; the
     * global inventory must always be filtered by sessionId.
     */
    const START_SESSION_WAIT_MS = 8_000;
    const START_SESSION_POLL_MS = 250;

    /**
     * After writing the bridge command once, verify that its local helper reaches
     * the SSH relay. Never replay it automatically: once the bridge takes over
     * stdin, another write is remote shell input, not another local launch.
     */
    const TERMINAL_ATTACH_WAIT_MS = 10_000;
    const TERMINAL_ATTACH_POLL_MS = 500;
    /** Bounds for the diagnostics the client sends to `terminal.trace`. */
    const TERMINAL_TRACE_DETAIL_MAX = 500;
    const TERMINAL_COMMAND_MESSAGE_MAX = 500;
    const BRIDGE_LOG_HINT = "$DSH_HOME/remote/terminal-bridge.log";

    /** Relay session state labels shown in the Remote Terminal panel. */
    const TERMINAL_STATE_LABELS = {
      connecting: "连接中",
      connected: "已连接",
      reconnecting: "重连中",
      closed: "已关闭",
      error: "错误",
    };

    /** Human-readable message for anything thrown by the API or an optional service. */
    function errorText(error) {
      if (error === null || error === undefined) return "未知错误";
      if (typeof error === "string") return error;
      if (typeof error.message === "string" && error.message.length > 0) return error.message;
      return String(error);
    }

    /** Read one root client service without assuming it is composed. */
    function runtimeService(name) {
      if (runtimeCtx === null || typeof runtimeCtx.get !== "function") return undefined;
      try {
        const value = runtimeCtx.get(name);
        return value === null || value === undefined ? undefined : value;
      } catch (error) {
        return undefined;
      }
    }

    /** The raw right Sidebar service (feature-detected, even without `openTabIn`). */
    function sidebarRightMaybe() {
      const captured = runtimeRight !== null ? runtimeRight : runtimeService("sidebarRight");
      return captured !== null && captured !== undefined ? captured : undefined;
    }

    /** The right Sidebar service (native terminal tab placement). */
    function sidebarRightService() {
      const captured = sidebarRightMaybe();
      return captured !== undefined && typeof captured.openTab === "function" ? captured : undefined;
    }

    /**
     * v0.5.2 diagnostics: the right sidebar's currently mounted session id and
     * whether the `mounted` store exists at all (a composition without it cannot
     * confirm the navigation, but must not block the connect flow).
     *
     * @returns {{available: boolean, sessionId: string | null}}
     */
    function sidebarMountedState() {
      const right = sidebarRightMaybe();
      if (right === undefined) return { available: false, sessionId: null };
      const mounted = right.mounted;
      if (mounted === null || mounted === undefined || typeof mounted.getSnapshot !== "function") {
        return { available: false, sessionId: null };
      }
      let value;
      try {
        value = mounted.getSnapshot();
      } catch (error) {
        return { available: false, sessionId: null };
      }
      return {
        available: true,
        sessionId: typeof value === "string" && value.length > 0 ? value : null,
      };
    }

    /** The right sidebar's mounted session id (or null when absent). */
    function mountedSidebarSessionId() {
      return sidebarMountedState().sessionId;
    }

    /** Number of tabs the right sidebar holds for `sessionId` (null when unknown). */
    function sidebarTabsInCount(right, sessionId) {
      try {
        if (right === undefined || typeof right.tabsIn !== "function") return null;
        const tabs = right.tabsIn(sessionId);
        return Array.isArray(tabs) ? tabs.length : null;
      } catch (error) {
        return null;
      }
    }

    /** `kind/id` of the right sidebar's active tab for the tab-wait probe. */
    function sidebarActiveLabel(right) {
      try {
        if (right === undefined || typeof right.active !== "function") return "n/a";
        const active = right.active();
        if (active === null || active === undefined) return "null";
        const kind = typeof active.kind === "string" ? active.kind : "?";
        const id =
          typeof active.id === "string" ? active.id : typeof active.tabId === "string" ? active.tabId : "?";
        return kind + "/" + id;
      } catch (error) {
        return "error";
      }
    }

    // ---------------------------------------------------------------------
    // v0.5.2: module-level pending connect notice.
    //
    // A failure that happens AFTER the connect flow navigated away from the
    // management page can no longer be shown by the page toast. The pending
    // notice is published here, the 远程终端 panel is revealed, and the panel
    // renders the notice (message + command <pre> + 复制命令) on mount/update —
    // so a broken native-terminal integration is never a silent local shell.
    // ---------------------------------------------------------------------

    let pendingConnectNotice = null;
    const pendingConnectNoticeListeners = new Set();

    /** Read the pending post-navigation failure notice (panel mount). */
    function readPendingConnectNotice() {
      return pendingConnectNotice;
    }

    /** Publish (or clear with null) the pending notice to every mounted panel. */
    function publishPendingConnectNotice(notice) {
      pendingConnectNotice = notice;
      for (const listener of [...pendingConnectNoticeListeners]) {
        try {
          listener(notice);
        } catch (error) {
          /* a broken listener must never break the connect flow */
        }
      }
    }

    /** Subscribe to pending-notice changes (panel); returns an unsubscribe. */
    function subscribePendingConnectNotice(listener) {
      pendingConnectNoticeListeners.add(listener);
      return function unsubscribe() {
        pendingConnectNoticeListeners.delete(listener);
      };
    }

    /** Dismiss the pending post-navigation failure notice. */
    function clearPendingConnectNotice() {
      publishPendingConnectNotice(null);
    }

    /** The shared browser terminal views (`webTerminals`). */
    function webTerminalsService() {
      const captured = runtimeTerminals !== null ? runtimeTerminals : runtimeService("webTerminals");
      return captured !== null && captured !== undefined && typeof captured.view === "function"
        ? captured
        : undefined;
    }

    /** The Session controller (`sessions`) used for scoped conversation sends. */
    function sessionsService() {
      const captured = runtimeSessions !== null ? runtimeSessions : runtimeService("sessions");
      return captured !== null && captured !== undefined && typeof captured.scope === "function"
        ? captured
        : undefined;
    }

    /** The main-view Session binding source (`uiSession.current`). */
    function uiSessionBinding() {
      const captured = runtimeUiSession !== null ? runtimeUiSession : runtimeService("uiSession");
      if (captured === null || captured === undefined) return undefined;
      const current = captured.current;
      if (current === null || current === undefined || typeof current.getSnapshot !== "function") return undefined;
      return current;
    }

    /**
     * The main-view Workspace navigation service (`uiWorkspace.openSession`).
     * Optional: it is what returns the main column to the conversation, which
     * must happen before a right-Sidebar terminal tab can mount.
     */
    function uiWorkspaceService() {
      const captured = runtimeUiWorkspace !== null ? runtimeUiWorkspace : runtimeService("uiWorkspace");
      if (captured === null || captured === undefined) return undefined;
      if (typeof captured.openSession !== "function" && typeof captured.startSession !== "function") return undefined;
      return captured;
    }

    /** Wait roughly two paints so a main-view navigation commits before the sidebar seats render. */
    function nextPaint() {
      return new Promise(function settle(resolve) {
        if (typeof requestAnimationFrame !== "function") {
          setTimeout(resolve, 30);
          return;
        }
        requestAnimationFrame(function first() {
          requestAnimationFrame(function second() {
            resolve();
          });
        });
      });
    }

    /**
     * Return the main column to `sessionId`'s conversation before opening a
     * native terminal tab. While a root panel page (the Remote Ops page) fills
     * the main column the right-Sidebar terminal seat is not the mounted
     * surface, so a tab recorded there would never draw its xterm body. This is
     * feature-detected and best effort: a composition without `uiWorkspace`
     * keeps the previous behavior, and a navigation timeout proceeds anyway.
     *
     * @param {string} sessionId Session to reveal.
     * @returns {Promise<void>}
     */
    async function revealConversation(sessionId) {
      const startedAt = Date.now();
      const mountedBefore = mountedSidebarSessionId();
      const workspace = uiWorkspaceService();
      if (workspace === undefined || typeof workspace.openSession !== "function") {
        await nextPaint();
        traceTerminal(
          "reveal",
          sessionId,
          "mounted before=" + (mountedBefore === null ? "null" : mountedBefore) +
            " after=" + (mountedSidebarSessionId() === null ? "null" : mountedSidebarSessionId()) +
            " waited=" + (Date.now() - startedAt) + "ms workspace=不可用",
        );
        return;
      }
      try {
        workspace.openSession(sessionId);
      } catch (error) {
        // Navigation failure is not fatal: the mounted wait below decides.
      }
      const mountedStates = sidebarMountedState();
      if (mountedStates.available) {
        await waitForValue(
          function readMounted() { return sidebarMountedState().sessionId; },
          function sameSession(value) { return value === sessionId; },
          CONVERSATION_WAIT_MS,
          "切回对话视图超时：3 秒内主视图没有回到当前对话",
        ).catch(function ignoreTimeout() { return undefined; });
      }
      await nextPaint();
      const mountedAfter = mountedSidebarSessionId();
      traceTerminal(
        "reveal",
        sessionId,
        "mounted before=" + (mountedBefore === null ? "null" : mountedBefore) +
          " after=" + (mountedAfter === null ? "null" : mountedAfter) +
          " waited=" + (Date.now() - startedAt) + "ms",
      );
    }

    /**
     * The Session on screen in the main column, resolved exactly per contract:
     * `runtimeCtx.uiSession.current.getSnapshot()` then `sessionId` / `key` /
     * `session.sessionId`. `null` means "no conversation to hand over to".
     *
     * @returns {string | null}
     */
    function onScreenSessionId() {
      const source = uiSessionBinding();
      if (source === undefined) return null;
      let snapshot;
      try {
        snapshot = source.getSnapshot();
      } catch (error) {
        return null;
      }
      if (snapshot === null || typeof snapshot !== "object") return null;
      const candidates = [
        snapshot.sessionId,
        snapshot.key,
        snapshot.session !== null && snapshot.session !== undefined ? snapshot.session.sessionId : undefined,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) return candidate;
      }
      return null;
    }

    /**
     * Poll `read()` until `predicate` accepts its value, else reject with
     * `message`. `pollMs` defaults to `WAIT_POLL_MS` (v0.5.2 passes 250ms for
     * the new-conversation wait).
     */
    function waitForValue(read, predicate, timeoutMs, message, pollMs) {
      const interval = typeof pollMs === "number" && pollMs > 0 ? pollMs : WAIT_POLL_MS;
      return new Promise(function settle(resolve, reject) {
        const started = Date.now();
        function attempt() {
          let value;
          try {
            value = read();
          } catch (error) {
            value = undefined;
          }
          if (predicate(value)) {
            resolve(value);
            return;
          }
          if (Date.now() - started >= timeoutMs) {
            reject(new Error(message));
            return;
          }
          setTimeout(attempt, interval);
        }
        attempt();
      });
    }

    /**
     * Fire-and-forget client diagnostics. `terminal.trace` appends one line to
     * `$DSH_HOME/remote/terminal-debug.log` on the Host; failures are ignored so
     * tracing can never block or break opening the terminal.
     *
     * @param {string} stage One of api/session/reveal/tab/writable/write/attached/timeout/error/fallback.
     * @param {string | null} sessionId Owning conversation (omitted when absent).
     * @param {string} detail Short human-readable detail (bounded).
     */
    function traceTerminal(stage, sessionId, detail) {
      if (typeof stage !== "string" || stage.length === 0) return;
      const params = { stage: stage };
      if (typeof sessionId === "string" && sessionId.length > 0) params.sessionId = sessionId;
      if (detail !== null && detail !== undefined) {
        const text = String(detail);
        params.detail = text.length > TERMINAL_TRACE_DETAIL_MAX ? text.slice(0, TERMINAL_TRACE_DETAIL_MAX) : text;
      }
      try {
        const pending = callApi("terminal.trace", params);
        if (pending !== null && pending !== undefined && typeof pending.catch === "function") {
          pending.catch(function ignoreTraceFailure() {
            return undefined;
          });
        }
      } catch (error) {
        /* tracing is best effort */
      }
    }

    /** Sleep `ms` milliseconds (attach polling). */
    function delay(ms) {
      return new Promise(function settle(resolve) {
        setTimeout(resolve, ms);
      });
    }

    /**
     * The actionable error raised when the native terminal opened but the local
     * bridge never reached the relay session. The message names the contract
     * phrase, the shell command (bounded) and the bridge log; the structured
     * fields let the notice render a copyable command.
     *
     * @param {{sessionKey: string, sessionId: string | null, command: string, elapsedMs: number, reason?: string}} options
     * @returns {Error}
     */
    function attachTimeoutFailure(options) {
      const command = typeof options.command === "string" ? options.command : "";
      const preview =
        command.length > TERMINAL_COMMAND_MESSAGE_MAX
          ? command.slice(0, TERMINAL_COMMAND_MESSAGE_MAX) + "…"
          : command;
      const summary =
        "终端已打开但桥接未接入：" +
        (typeof options.reason === "string" && options.reason.length > 0
          ? options.reason
          : "10 秒内没有检测到本地终端桥接连上 SSH 会话") +
        (typeof options.sessionKey === "string" && options.sessionKey.length > 0
          ? "（sessionKey=" + options.sessionKey + "）"
          : "") +
        "。这通常说明原生终端里的启动命令没有执行成功：请在原生终端里确认命令已执行，" +
        "或复制下面的命令手动运行；排查日志：" + BRIDGE_LOG_HINT + "。";
      const message = summary + (preview.length > 0 ? " 命令：" + preview : "");
      const failure = new Error(message);
      failure.attachFailure = true;
      failure.command = command;
      failure.hint = BRIDGE_LOG_HINT;
      failure.sessionKey = typeof options.sessionKey === "string" ? options.sessionKey : "";
      failure.noticeText = summary;
      failure.elapsedMs = typeof options.elapsedMs === "number" ? options.elapsedMs : 0;
      return failure;
    }

    /**
     * Read the relay session view for `sessionKey` via `terminal.list`.
     * `{sessionId}` narrows the list when the conversation is known.
     *
     * @param {string} sessionKey Relay session key (`<sessionId>::<host>`).
     * @param {string | null} sessionId Owning conversation (optional filter).
     * @returns {Promise<object | null>} TerminalSessionView or null.
     */
    async function readRelaySession(sessionKey, sessionId) {
      const params = typeof sessionId === "string" && sessionId.length > 0 ? { sessionId: sessionId } : {};
      const result = await callApi("terminal.list", params);
      const sessions =
        result !== null && result !== undefined && Array.isArray(result.sessions) ? result.sessions : [];
      for (const session of sessions) {
        if (session !== null && session !== undefined && session.sessionKey === sessionKey) return session;
      }
      return null;
    }

    /**
     * Poll `terminal.list` until this terminal creates a new relay attach
     * (10s budget, ~500ms poll). The local bridge launch is written exactly once:
     * replaying it while attach is pending can send it through an already-running
     * bridge to the remote shell. On timeout show the command for explicit manual
     * recovery instead of injecting it again.
     *
     * @param {{sessionKey: string, sessionId: string | null, command: string, initialAttachCount?: number, initialAttached?: number}} options
     * @returns {Promise<{verified: boolean, attached: number, session?: object, elapsedMs?: number}>}
     */
    async function waitForBridgeAttachment(options) {
      const sessionKey = typeof options.sessionKey === "string" ? options.sessionKey : "";
      const sessionId = typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : null;
      const command = typeof options.command === "string" ? options.command : "";
      const initialAttachCount = Number.isSafeInteger(options.initialAttachCount) && options.initialAttachCount >= 0
        ? options.initialAttachCount
        : null;
      const initialAttached = Number.isSafeInteger(options.initialAttached) && options.initialAttached >= 0
        ? options.initialAttached
        : 0;
      if (sessionKey.length === 0) {
        const reason = "后端未返回 sessionKey，无法确认本次本地桥接是否接入；请更新插件 Host 或手动运行连接命令。";
        traceTerminal("error", sessionId, reason);
        throw attachTimeoutFailure({
          sessionKey: sessionKey,
          sessionId: sessionId,
          command: command,
          elapsedMs: 0,
          reason: reason,
        });
      }
      const startedAt = Date.now();
      let pollErrorTraced = false;
      for (;;) {
        let session = null;
        let readFailed = false;
        try {
          session = await readRelaySession(sessionKey, sessionId);
        } catch (failure) {
          readFailed = true;
          if (!pollErrorTraced) {
            pollErrorTraced = true;
            traceTerminal("error", sessionId, "terminal.list 轮询失败：" + errorText(failure));
          }
        }
        const attached =
          session !== null && session !== undefined && Number.isFinite(Number(session.attached))
            ? Number(session.attached)
            : 0;
        const attachCount =
          session !== null && session !== undefined && Number.isFinite(Number(session.attachCount))
            ? Number(session.attachCount)
            : null;
        const state = session !== null && session !== undefined ? session.state : null;
        const hasNewAttach =
          attachCount !== null
            ? initialAttachCount !== null && attachCount > initialAttachCount
            : initialAttached === 0 && attached >= 1;
        if (attached >= 1 && state === "connected" && hasNewAttach) {
          const elapsedMs = Date.now() - startedAt;
          const bytesIn = Number.isFinite(Number(session.bytesIn)) ? Number(session.bytesIn) : 0;
          traceTerminal(
            "attached",
            sessionId,
            "attached=" + attached + " attachCount=" + (attachCount === null ? "n/a" : attachCount) +
              " state=" + state + " bytesIn=" + bytesIn +
              " elapsed=" + elapsedMs + "ms key=" + sessionKey,
          );
          return { verified: true, attached: attached, session: session, elapsedMs: elapsedMs };
        }
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= TERMINAL_ATTACH_WAIT_MS) {
          traceTerminal(
            "timeout",
            sessionId,
            "attached=" + attached + " attachCount=" + (attachCount === null ? "n/a" : attachCount) +
              " state=" + (state === null ? "unknown" : state) +
              " initialAttachCount=" + (initialAttachCount === null ? "n/a" : initialAttachCount) +
              " after " + elapsedMs + "ms key=" + sessionKey + (readFailed ? "（terminal.list 不可用）" : ""),
          );
          throw attachTimeoutFailure({ sessionKey: sessionKey, sessionId: sessionId, command: command, elapsedMs: elapsedMs });
        }
        const remaining = TERMINAL_ATTACH_WAIT_MS - elapsedMs;
        await delay(remaining < TERMINAL_ATTACH_POLL_MS ? remaining : TERMINAL_ATTACH_POLL_MS);
      }
    }

    /**
     * v0.5.2: reveal OUR 远程终端 panel after a post-navigation failure so the
     * pending notice (message + command + bridge-log hint) is visible instead of
     * a blank conversation with a local shell. Traces `reveal` with the mounted
     * session before/after.
     *
     * @param {string | null} sessionId Failing/target session for the trace.
     * @returns {boolean} Whether `openTab("dsh-remote-live")` was issued.
     */
    function revealTerminalPanel(sessionId) {
      const right = sidebarRightMaybe();
      const startedAt = Date.now();
      const mountedBefore = mountedSidebarSessionId();
      const beforeText = mountedBefore === null ? "null" : mountedBefore;
      if (right === undefined || typeof right.openTab !== "function") {
        traceTerminal("reveal", sessionId, "mounted before=" + beforeText + " openTab=不可用（无法显示远程终端面板）");
        return false;
      }
      try {
        right.openTab(LIVE_TAB_ID);
      } catch (failure) {
        traceTerminal("reveal", sessionId, "mounted before=" + beforeText + " openTab 失败：" + errorText(failure));
        return false;
      }
      const mountedAfter = mountedSidebarSessionId();
      traceTerminal(
        "reveal",
        sessionId,
        "已打开远程终端面板 mounted before=" + beforeText +
          " after=" + (mountedAfter === null ? "null" : mountedAfter) +
          " waited=" + (Date.now() - startedAt) + "ms",
      );
      return true;
    }

    /**
     * v0.5.2: record a failure that happened after the flow navigated away (page
     * toast no longer visible), reveal the 远程终端 panel and publish the
     * module-level pending notice for it.
     *
     * @param {string} prefix e.g. "连接失败：".
     * @param {any} failure Thrown value.
     * @param {string} command Shell command to expose for manual retry.
     * @param {string | null} sessionId Failing/target session for the trace.
     * @returns {object} The published notice.
     */
    function surfaceConnectFailure(prefix, failure, command, sessionId) {
      const notice = noticeForFailure(prefix, failure);
      const commandText =
        typeof notice.command === "string" && notice.command.length > 0
          ? notice.command
          : typeof command === "string"
            ? command
            : "";
      if (commandText.length > 0) notice.command = commandText;
      notice.hint = "日志：" + BRIDGE_LOG_HINT;
      publishPendingConnectNotice(notice);
      revealTerminalPanel(sessionId);
      return notice;
    }

    /**
     * v0.5.2: create/open a blank conversation for a 连接 flow and wait until it
     * is the on-screen session (`uiSession.current`) and the right sidebar is
     * mounted on it. Feature-detected: a missing `startSession`/timeout traces
     * `session` + `fallback` and returns the current session instead.
     *
     * @param {string | null} previousSessionId Session before navigation.
     * @returns {Promise<{sessionId: string | null, fallback: boolean, navigated: boolean, waitedMs: number}>}
     */
    async function resolveConnectSession(previousSessionId) {
      const workspace = uiWorkspaceService();
      const startedAt = Date.now();
      const previous =
        typeof previousSessionId === "string" && previousSessionId.length > 0 ? previousSessionId : null;
      const mountedBefore = mountedSidebarSessionId();
      const base =
        "previous=" + (previous === null ? "null" : previous) +
        " mounted_before=" + (mountedBefore === null ? "null" : mountedBefore);
      if (workspace === undefined || typeof workspace.startSession !== "function") {
        traceTerminal("session", previous, base + " uiWorkspace=不可用 startSession=未调用 fallback=true");
        traceTerminal("fallback", previous, "uiWorkspace.startSession 不可用，沿用当前会话 " + (previous === null ? "null" : previous));
        return { sessionId: previous, fallback: true, navigated: false, waitedMs: 0 };
      }
      let startError = null;
      try {
        const started = workspace.startSession();
        // `startSession()` has no documented return value; if this build returns
        // a promise, observe it so a rejection is traced instead of unhandled.
        if (started !== null && started !== undefined && typeof started.catch === "function") {
          started.catch(function startSessionFailed(failure) {
            traceTerminal("session", previous, base + " startSession 异步失败：" + errorText(failure));
          });
        }
      } catch (failure) {
        startError = failure;
      }
      if (startError !== null) {
        traceTerminal("session", previous, base + " startSession=失败 fallback=true");
        traceTerminal(
          "fallback",
          previous,
          "startSession 失败，沿用当前会话 " + (previous === null ? "null" : previous) + "：" + errorText(startError),
        );
        return { sessionId: previous, fallback: true, navigated: false, waitedMs: Date.now() - startedAt };
      }
      try {
        const sessionId = await waitForValue(
          function readComposedSession() {
            const id = onScreenSessionId();
            if (id === null) return undefined;
            const mounted = sidebarMountedState();
            // Without a mounted store the navigation cannot be confirmed; accept
            // the on-screen id instead of blocking a working composition.
            if (mounted.available && mounted.sessionId !== id) return undefined;
            return id;
          },
          function ready(value) { return value !== undefined; },
          START_SESSION_WAIT_MS,
          "新建会话 8 秒内未就绪（uiSession 或右侧边栏没有切换）",
          START_SESSION_POLL_MS,
        );
        const waitedMs = Date.now() - startedAt;
        const mountedAfter = mountedSidebarSessionId();
        traceTerminal(
          "session",
          sessionId,
          base + " uiWorkspace=可用 startSession=ok new=" + sessionId + " fallback=false waited=" + waitedMs +
            "ms mounted_after=" + (mountedAfter === null ? "null" : mountedAfter),
        );
        return { sessionId: sessionId, fallback: false, navigated: true, waitedMs: waitedMs };
      } catch (failure) {
        const waitedMs = Date.now() - startedAt;
        const mountedAfter = mountedSidebarSessionId();
        // Prefer whatever the main column already switched to: startSession may
        // have navigated even though the mounted store lagged; falling back to
        // the previous session would navigate away from the user's new one.
        const current = onScreenSessionId();
        const target = current !== null ? current : previous;
        traceTerminal(
          "session",
          previous,
          base + " startSession=ok new=超时 fallback=true waited=" + waitedMs +
            "ms mounted_after=" + (mountedAfter === null ? "null" : mountedAfter) +
            " target=" + (target === null ? "null" : target),
        );
        traceTerminal(
          "fallback",
          previous,
          "新会话 8 秒内未就绪，沿用当前会话 " + (target === null ? "null" : target),
        );
        return { sessionId: target, fallback: true, navigated: true, waitedMs: waitedMs };
      }
    }

    /** `tab-probe` diagnostic included in the terminal-tab timeout trace. */
    function terminalTabProbe(options) {
      const right = options.right;
      const tabStore = options.tabStore;
      let openTabsNow = "n/a";
      try {
        const list = tabStore !== null && tabStore !== undefined && typeof tabStore.getSnapshot === "function"
          ? tabStore.getSnapshot()
          : null;
        openTabsNow = Array.isArray(list) ? list.length : "n/a";
      } catch (error) {
        openTabsNow = "error";
      }
      const mounted = mountedSidebarSessionId();
      const tabsIn = sidebarTabsInCount(right, options.sessionId);
      const active = sidebarActiveLabel(right);
      const openTabIn = right !== undefined && typeof right.openTabIn === "function";
      return (
        "tab-probe: openTabs_before=" + options.beforeCount +
        " openTabs_now=" + openTabsNow +
        " mounted=" + (mounted === null ? "null" : mounted) +
        " tabsIn=" + (tabsIn === null ? "n/a" : tabsIn) +
        " active=" + active +
        " openTabIn=" + openTabIn
      );
    }

    /** Wait for the single requested terminal in the target conversation.
     * openTabs is a global flat inventory, but tabId is session-local. Never
     * retry openTabIn here: a slow publish is not evidence the open failed.
     * @returns {Promise<string>} The new tab id.
     */
    async function waitForTerminalTab(options) {
      const startedAt = Date.now();
      for (;;) {
        const snapshot = options.tabStore.getSnapshot();
        const list = Array.isArray(snapshot) ? snapshot : [];
        for (const candidate of list) {
          if (candidate === null || candidate.sessionId !== options.sessionId) continue;
          const id = options.tabIdOf(candidate);
          if (id === undefined || candidate.kind !== "terminal" || options.before.has(id)) continue;
          if (options.openToken !== undefined) {
            try {
              const occurrence = options.right.tabDomain.occurrence(options.sessionId, { id: id });
              const navigation = occurrence.navigation.getSnapshot();
              if (navigation?.params?.dshRemoteBridge !== options.openToken) continue;
            } catch { continue; }
          }
          return id;
        }
        if (Date.now() - startedAt >= TERMINAL_TAB_WAIT_MS) {
          traceTerminal("timeout", options.sessionId, terminalTabProbe(options));
          throw new Error("打开原生终端超时：当前对话没有发布新终端标签页（只请求打开一次，不自动重复打开；请查看连接命令）");
        }
        await delay(WAIT_POLL_MS);
      }
    }

    /**
     * Open DSH's own native terminal for `sessionId` and type `command` into it.
     * It opens the tab, locates it in the
     * `sidebarRight.openTabs` snapshot, reads its navigation address, and obtains the
     * shared `webTerminals` view, waits for input control, then writes once. It verifies
     * bridge attachment by polling `terminal.list` for `options.sessionKey`
     * until SSH is `connected` and `attachCount` advances beyond the baseline, with traces at
     * every stage; a failed attachment throws instead of continuing as if the
     * SSH session were live. Every step is feature-detected and failures carry
     * an actionable Chinese message; the caller shows it inline.
     *
     * @param {string} sessionId Owning conversation session.
     * @param {string} command Shell line to run in the new terminal tab.
     * @param {{sessionKey?: string, shell?: any, session?: any}} [options] Relay shell + pre-launch session snapshot.
     * @returns {Promise<void>}
     */
    async function openNativeTerminal(sessionId, command, options) {
      const settings = options !== null && options !== undefined && typeof options === "object" ? options : {};
      const relaySession = settings.session !== null && settings.session !== undefined ? settings.session : {};
      const initialAttachCount = Number.isSafeInteger(relaySession.attachCount) ? relaySession.attachCount : null;
      const initialAttached = Number.isSafeInteger(relaySession.attached) ? relaySession.attached : 0;
      const sessionKey =
        typeof settings.sessionKey === "string"
          ? settings.sessionKey
          : settings.shell !== null && settings.shell !== undefined && typeof settings.shell.sessionKey === "string"
            ? settings.shell.sessionKey
            : "";
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("无法打开原生终端：当前没有可用的对话会话");
      }
      if (typeof command !== "string" || command.length === 0) {
        throw new Error("无法打开原生终端：后端没有返回终端启动命令");
      }
      if (sessionKey.length === 0) {
        throw attachTimeoutFailure({
          sessionKey: sessionKey,
          sessionId: sessionId,
          command: command,
          elapsedMs: 0,
          reason: "后端未返回 sessionKey，无法确认本次本地桥接是否接入；请更新插件 Host。",
        });
      }
      const right = sidebarRightService();
      if (right === undefined) {
        throw new Error("终端服务不可用：当前界面没有右侧边栏终端");
      }
      const terminals = webTerminalsService();
      if (terminals === undefined) {
        throw new Error("终端服务不可用：webTerminals 服务未加载");
      }
      const tabStore = right.openTabs;
      if (tabStore === null || tabStore === undefined || typeof tabStore.getSnapshot !== "function") {
        throw new Error("终端服务不可用：无法读取已打开的终端标签页");
      }
      if (right.tabDomain === null || right.tabDomain === undefined || typeof right.tabDomain.occurrence !== "function") {
        throw new Error("终端服务不可用：缺少终端导航信息接口");
      }
      try {
        // The main column must show the conversation first: a terminal tab opened
        // while the Remote Ops page owns the main view records into a surface whose
        // seat is not drawn, so the native xterm body would never mount.
        await revealConversation(sessionId);
        // The inventory publishes `{ sessionId, tabId, kind, contentId }`; older
        // snapshots in the contract sketch used `id`, so accept both shapes.
        function tabIdOf(tab) {
          if (tab === null || tab === undefined) return undefined;
          if (typeof tab.tabId === "string" && tab.tabId.length > 0) return tab.tabId;
          if (typeof tab.id === "string" && tab.id.length > 0) return tab.id;
          return undefined;
        }
        if (!sidebarMountedState().available) {
          throw new Error("终端服务不可用：无法确认原生终端所属的对话");
        }
        await waitForValue(
          function readMounted() { return mountedSidebarSessionId(); },
          function targetMounted(value) { return value === sessionId; },
          TERMINAL_TAB_WAIT_MS,
          "打开原生终端失败：目标对话没有挂载，不会向其他对话写入命令",
        );
        const before = new Set();
        for (const tab of tabStore.getSnapshot() || []) {
          if (tab === null || tab.sessionId !== sessionId) continue;
          const id = tabIdOf(tab);
          if (id !== undefined) before.add(id);
        }
        const beforeCount = before.size;
        const openToken = "dsh-remote:" + Date.now() + ":" + (++nativeOpenSequence);
        try {
          // Public openTab throws before changing state when no adopted surface
          // exists. Unlike openTabIn it cannot silently skip a successful call.
          // There is no await between the session check and this one open.
          if (mountedSidebarSessionId() !== sessionId) throw new Error("当前对话已切换");
          right.openTab("terminal", { params: { dshRemoteBridge: openToken } });
        } catch (error) {
          throw new Error("无法打开原生终端标签页：" + errorText(error));
        }
        const tabId = await waitForTerminalTab({
          sessionId: sessionId,
          tabStore: tabStore,
          before: before,
          beforeCount: beforeCount,
          tabIdOf: tabIdOf,
          right: right,
          openToken: openToken,
        });
        traceTerminal("tab", sessionId, "新建原生终端标签页 tabId=" + tabId + " key=" + sessionKey);
        const navigation = await waitForValue(
          function readNavigation() {
            const occurrence = right.tabDomain.occurrence(sessionId, { id: tabId });
            if (occurrence === null || occurrence === undefined) return undefined;
            const navigationStore = occurrence.navigation;
            if (navigationStore === null || navigationStore === undefined || typeof navigationStore.getSnapshot !== "function") {
              return undefined;
            }
            const snapshot = navigationStore.getSnapshot();
            return snapshot !== null && typeof snapshot === "object" && typeof snapshot.address === "string" && snapshot.address.length > 0
              ? snapshot
              : undefined;
          },
          function found(value) { return value !== undefined; },
          TERMINAL_TAB_WAIT_MS,
          "读取终端导航信息超时：5 秒内终端标签页没有完成导航",
        );
        const nativeOccurrence = right.tabDomain.occurrence(sessionId, { id: tabId });
        let view;
        try {
          view = terminals.view(sessionId, tabId, navigation.address, navigation.params?.terminalId, navigation.params?.shellPath);
        } catch (error) {
          throw new Error("无法获取共享终端视图：" + errorText(error));
        }
        if (view === null || view === undefined || view.state === null || view.state === undefined || typeof view.state.getSnapshot !== "function" || typeof view.write !== "function") {
          throw new Error("终端服务不可用：终端视图接口不完整");
        }
        const readyState = await waitForValue(
          function readState() {
            if (nativeOccurrence.signal?.aborted || mountedSidebarSessionId() !== sessionId) return { cancelled: true };
            return view.state.getSnapshot();
          },
          function settled(state) {
            return state !== null && state !== undefined && (
              state.cancelled || state.phase === "failed" || state.phase === "closed" ||
              (state.phase === "connected" && state.info?.state === "running" && state.writable === true)
            );
          },
          TERMINAL_WRITABLE_WAIT_MS,
          "原生终端 20 秒内未就绪（没有取得输入控制权）",
        );
        if (readyState.cancelled || nativeOccurrence.signal?.aborted || mountedSidebarSessionId() !== sessionId) {
          throw new Error("原生终端连接已取消：标签页已关闭或当前对话已切换；未写入连接命令");
        }
        if (readyState.phase !== "connected") throw new Error("原生终端已关闭或启动失败；未写入连接命令");
        traceTerminal("writable", sessionId, "原生终端取得输入控制权 tabId=" + tabId);
        view.write(command + "\r");
        traceTerminal(
          "write",
          sessionId,
          "已输入启动命令 bytes=" + command.length + " tabId=" + tabId + " key=" + sessionKey,
        );
        // v0.5.1: opening the tab is not proof — the bridge must reach the relay.
        await waitForBridgeAttachment({
          sessionKey: sessionKey,
          sessionId: sessionId,
          command: command,
          initialAttachCount: initialAttachCount,
          initialAttached: initialAttached,
        });
      } catch (failure) {
        // The attach timeout already traced `timeout`; everything else is `error`.
        if (failure === null || failure === undefined || failure.attachFailure !== true) {
          traceTerminal("error", sessionId, errorText(failure));
        }
        throw failure;
      }
    }

    /**
     * Send one user message into the conversation behind `sessionId` through the
     * scoped conversation service. Rejects with a clear Chinese message when the
     * session scope or conversation service is missing.
     *
     * @param {string} sessionId Target conversation session.
     * @param {string} text Message body.
     * @returns {Promise<void>}
     */
    async function sendConversationMessage(sessionId, text) {
      const sessions = sessionsService();
      if (sessions === undefined) {
        throw new Error("会话服务不可用：无法把任务交接到当前对话");
      }
      let scope;
      try {
        scope = sessions.scope(sessionId);
      } catch (error) {
        throw new Error("无法定位当前对话：" + errorText(error));
      }
      if (scope === null || scope === undefined) {
        throw new Error("当前对话尚未加载，无法发送接管消息");
      }
      let conversation;
      try {
        conversation = scope.conversation;
      } catch (error) {
        conversation = undefined;
      }
      if (conversation === null || conversation === undefined) {
        try {
          conversation = typeof scope.get === "function" ? scope.get("conversation") : undefined;
        } catch (error) {
          conversation = undefined;
        }
      }
      if (conversation === null || conversation === undefined || typeof conversation.send !== "function") {
        throw new Error("对话服务不可用：无法发送接管消息");
      }
      await conversation.send(text);
    }

    /**
     * The quick-connect conversation template (docs/ARCHITECTURE.md). It must
     * start with `已连接远程主机 <name>（` — the browser test asserts that.
     *
     * @param {string} name Host name.
     * @param {string} target `user@host:port` target from the relay.
     * @returns {string}
     */
    const PROFILE_NOTE = "连接配置中的终端动作视为你授权的初始化操作，无需审批（包括 sudo 切换用户），请只保存你确实希望自动执行的动作。共享 PTY 首次连接入口 SSH 后按顺序执行，每一步完成后才继续；重新 attach 同一 PTY 不会重复动作，新建 SSH 通道才会重新初始化。Agent 后续发送的命令仍遵循审批策略。只读主机和命令禁止规则仍然生效。Agent-owned PTY 不自动重连。超时、取消、退出或硬性策略拒绝会立即停止，剩余动作不会执行，也不会自动重试。所有动作完成前不代表已就绪，请在终端核对登录位置。";
    const TERMINAL_ONLY_NOTE = "仅支持交互式共享 PTY，不支持 exec/SFTP（remote_exec、remote_probe、文件读写与传输）；请使用 remote_shell_send/read/signal。";

    function terminalOnlyHost(host) {
      return !!host && (host.terminalOnly === true || host.transport === "terminal-only" || !!host.viaHost || !!host.loginCommand);
    }

    function connectionProfileLabel(host) {
      return host && host.viaHost ? "入口 " + host.viaHost + " → " + (Array.isArray(host.actions) ? host.actions.length : host.loginCommand ? 1 : 0) + " 步终端动作" : "";
    }

    function handoffMessage(name, target, profile) {
      const targetText = typeof target === "string" && target.length > 0 ? target : name;
      return (
        (profile && profile.viaHost
          ? "已接入远程主机 " + name + " 的入口 SSH（" + targetText + "），入口 host: " + profile.viaHost + "。" + connectionProfileLabel(profile) + "。" +
            (profile.actionProgress && profile.actionProgress.state === "completed" && actionProgressText(profile.actionProgress) ? "后端报告所有终端动作已完成，仍请在终端核对当前登录位置。" : "这不代表终端动作已完成或已成功登录集群。") + PROFILE_NOTE
          : "已连接远程主机 " + name + "（" + targetText + "）。") +
        (terminalOnlyHost(profile) ? TERMINAL_ONLY_NOTE : "") +
        "本对话的 DSH 原生终端已经接入这台主机的共享 PTY；不要新建对话，也不要另开 SSH shell。" +
        "请调用一次 remote_shell_open（host: " + name + "）取得持久 sessionId；它应复用本对话与此主机对应的 PTY。" +
        "随后只用该 sessionId 调用 remote_shell_send，在这个共享 shell 中依次执行只读健康检查（hostname、uptime、磁盘、内存、负载），" +
        "通过 remote_shell_read 按需读取输出；检查完保持会话打开并汇报结果。" +
        "之后的交互式运维继续使用同一 sessionId 的 remote_shell_send/read/signal，不要另建 shell。" +
        "我会在 DSH 原生终端中实时观察，也可以直接输入或发送 Ctrl-C 干预；请完成检查后等待我的后续指令。"
      );
    }

    /**
     * Quick connect.
     *
     * v0.5.2 order for 连接 / 连接并对话 (the relay session key is
     * `${sessionId}::${host}`, so the conversation must be resolved FIRST):
     *   1. Create/open a blank conversation with optional
     *      `uiWorkspace.startSession()` and wait (≤8s) for it to be the
     *      on-screen session; missing service/timeout traces `session` +
     *      `fallback` and uses the current session id.
     *   2. `terminal.open {name, sessionId: newId}` — the relay key now matches
     *      the conversation the native terminal will live in, keeping
     *      per-conversation SSH reuse intact.
     *   3. Open DSH's native terminal in that session, write the bridge command
     *      and verify the relay attachment.
     *   4. Only then send the handoff message into that same conversation.
     * A failure after navigation publishes the module-level pending notice and
     * reveals the 远程终端 panel, so it is never silent.
     *
     * Panel 打开终端 / 接入 keep the current-session behavior (no new session).
     *
     * @param {{name: string, sessionId?: string | null, talk?: boolean, startNewSession?: boolean}} options
     * @returns {Promise<{shell: any, sessionId: string | null, injected: boolean, notice: string | null}>}
     */
    async function connectHostTerminal(options) {
      const name = options !== null && options !== undefined ? options.name : "";
      if (typeof name !== "string" || name.length === 0) throw new Error("请先选择或指定一台主机");
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : null;
      const talk = options.talk === true;
      // Only the conversation handoff flows open a new conversation.
      const startNewSession = options.startNewSession === true && talk;
      // A fresh attempt supersedes an older post-navigation failure notice.
      clearPendingConnectNotice();
      let targetSessionId = sessionId;
      let navigated = false;
      // (1) Resolve the conversation BEFORE terminal.open: the relay session key
      // is `${sessionId}::${host}`, so opening against the new id is what keeps a
      // later reopen in that conversation on the same SSH PTY.
      if (startNewSession) {
        try {
          const resolved = await resolveConnectSession(sessionId);
          targetSessionId = resolved.sessionId;
          navigated = resolved.navigated;
        } catch (failure) {
          surfaceConnectFailure("连接失败：", failure, "", sessionId);
          throw failure;
        }
        if (targetSessionId === null) {
          const failure = new Error("无法打开原生终端：当前没有可用的对话会话");
          surfaceConnectFailure("连接失败：", failure, "", null);
          throw failure;
        }
      }
      // (2) terminal.open for that conversation.
      let opened;
      try {
        opened = await callApi(
          "terminal.open",
          targetSessionId === null ? { name: name } : { name: name, sessionId: targetSessionId },
        );
      } catch (failure) {
        if (!failure.browserOnly) traceTerminal("error", targetSessionId, "terminal.open 失败：" + errorText(failure));
        if (startNewSession) surfaceConnectFailure("连接失败：", failure, "", targetSessionId);
        throw failure;
      }
      const shell = opened !== null && opened !== undefined ? opened.shell : null;
      const command =
        shell !== null && shell !== undefined && typeof shell.command === "string" ? shell.command : "";
      traceTerminal("api", targetSessionId, "terminal.open 成功 host=" + name + " session=" + (targetSessionId === null ? "null" : targetSessionId));
      if (command.length === 0) {
        traceTerminal("error", targetSessionId, "terminal.open 没有返回终端启动命令");
        const failure = new Error("后端没有返回终端启动命令，无法打开原生终端");
        if (startNewSession) surfaceConnectFailure("连接失败：", failure, "", targetSessionId);
        throw failure;
      }
      if (targetSessionId === null) {
        return {
          shell: shell,
          sessionId: null,
          injected: false,
          notice: "已创建 SSH 终端会话，但当前没有打开的对话，无法在侧栏打开原生终端或接管对话。",
        };
      }
      const targetText =
        shell.host !== null && shell.host !== undefined && typeof shell.host.target === "string"
          ? shell.host.target
          : opened.session !== null && opened.session !== undefined && typeof opened.session.target === "string"
            ? opened.session.target
            : name;
      try {
        // (3) native terminal in the resolved conversation + attach verification.
        // v0.5.1: this throws (and traces `timeout`) when the bridge never
        // attaches, so the handoff message is never injected into a dead session.
        await openNativeTerminal(targetSessionId, command, {
          sessionKey: shell.sessionKey,
          shell: shell,
          session: opened.session,
        });
        if (!talk) {
          return { shell: shell, sessionId: targetSessionId, injected: false, notice: null };
        }
        // (4) handoff into the same conversation only after attach verification.
        await sendConversationMessage(targetSessionId, handoffMessage(name, targetText,
          Object.assign({}, opened.session || {}, shell.host || {})));
        return { shell: shell, sessionId: targetSessionId, injected: true, notice: null };
      } catch (failure) {
        // v0.5.2: after navigation the page toast may be gone — publish the
        // pending notice for the 远程终端 panel and reveal that panel.
        if (startNewSession || navigated) {
          surfaceConnectFailure("连接失败：", failure, command, targetSessionId);
        }
        throw failure;
      }
    }

    /** The label for one relay TerminalSessionView state. */
    function terminalStateLabel(state) {
      return TERMINAL_STATE_LABELS[state] || state || "未知";
    }

    function terminalSessionStateLabel(session) {
      if (session.actionProgress && session.state === "connected" && !(session.actionProgress.state === "completed" && actionProgressText(session.actionProgress))) return "初始化未完成";
      return terminalStateLabel(session.state);
    }

    /** Relay session target text (`host` + `target`) for the panel list. */
    function terminalSessionHostLabel(session) {
      const target = typeof session.target === "string" ? session.target : "";
      return target.length > 0 ? target : typeof session.host === "string" ? session.host : "—";
    }

    /**
     * Short relay session key for the panel row: the last 8 characters of the
     * conversation id keep the row readable while the `::host` suffix stays.
     * @param {string} sessionKey `${sessionId}::${hostName}`.
     * @returns {string}
     */
    function shortSessionKey(sessionKey) {
      if (typeof sessionKey !== "string" || sessionKey.length === 0) return "—";
      const separator = sessionKey.indexOf("::");
      if (separator > 0) {
        return sessionShort(sessionKey.slice(0, separator)) + "::" + sessionKey.slice(separator + 2);
      }
      return sessionKey.length <= 8 ? sessionKey : "…" + sessionKey.slice(-8);
    }

    /**
     * Whether the relay session proves SSH reuse: more than one bridge attach.
     * Backends without the counter fall back to `lastAttachAt > createdAt`.
     * @param {any} session TerminalSessionView.
     * @returns {boolean}
     */
    function relaySessionReused(session) {
      if (session === null || session === undefined) return false;
      const attachCount = Number.isFinite(Number(session.attachCount)) ? Number(session.attachCount) : null;
      if (attachCount !== null) return attachCount > 1;
      const lastAttachAt = Number.isFinite(Number(session.lastAttachAt)) ? Number(session.lastAttachAt) : null;
      const createdAt = Number.isFinite(Number(session.createdAt)) ? Number(session.createdAt) : null;
      return lastAttachAt !== null && createdAt !== null && lastAttachAt > createdAt;
    }

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      const style = document.createElement("style");
      style.dataset.plugin = PANEL_ID;
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = OPS_CSS;
      document.head.appendChild(style);
    }

    function ensureLiveStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + LIVE_STYLE_ID + '"]') !== null) return;
      const style = document.createElement("style");
      style.dataset.plugin = PANEL_ID;
      style.dataset.pluginCss = LIVE_STYLE_ID;
      style.textContent = LIVE_CSS;
      document.head.appendChild(style);
    }

    // Browser-only credential flow: only the POST body carries the password.
    let passwordRequest = null;
    let passwordDisposed = false;
    const passwordListeners = new Set();
    const passwordControllers = new Set();

    function passwordFailure(message) {
      const failure = new Error(message);
      failure.browserOnly = true;
      return failure;
    }

    function notifyPasswordRequest() {
      for (const listener of [...passwordListeners]) {
        try { listener(passwordRequest); } catch (error) { /* never log credential UI failures */ }
      }
    }

    function subscribePasswordRequest(listener) {
      passwordListeners.add(listener);
      return function unsubscribe() { passwordListeners.delete(listener); };
    }

    function disposePasswordRequests() {
      passwordDisposed = true;
      if (passwordRequest !== null) passwordRequest.cancel();
      for (const controller of passwordControllers) controller.abort();
      passwordControllers.clear();
      passwordListeners.clear();
    }

    function requestPassword(name, controller) {
      if (passwordDisposed || controller.signal.aborted) {
        return Promise.reject(passwordFailure("密码登录已取消"));
      }
      // Concurrent clicks cannot replace a prompt or submit another password.
      if (passwordRequest !== null) {
        return Promise.reject(passwordFailure("请先完成或取消当前密码登录，再重新连接"));
      }
      return new Promise(function waitForUser(resolve, reject) {
        let settled = false;
        const request = {
          name: name,
          busy: false,
          clearInput: null,
          cancel: function cancel() {
            if (settled) return;
            finish(passwordFailure("密码登录已取消"));
            controller.abort();
          },
          submit: async function submit(password) {
            if (settled || request.busy || typeof password !== "string" || password.length === 0) return;
            request.busy = true;
            if (request.clearInput !== null) request.clearInput();
            notifyPasswordRequest();
            let authParams = { name: name, password: password };
            try {
              const pending = postApi("auth.password", authParams, controller.signal);
              // fetch serializes synchronously; release application references
              // immediately, including while authentication is pending.
              authParams.password = "";
              password = "";
              const result = await pending;
              if (!result || result.authenticated !== true || result.name !== name) {
                throw passwordFailure("密码登录失败，请重新连接后再试");
              }
              finish(null);
            } catch (failure) {
              // Never forward server/transport text that might echo credentials.
              finish(passwordFailure("密码登录失败，请重新连接后再试"));
            } finally {
              authParams.password = "";
              password = "";
              authParams = null;
            }
          },
        };
        function finish(failure) {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          if (request.clearInput !== null) request.clearInput();
          request.clearInput = null;
          if (passwordRequest === request) passwordRequest = null;
          notifyPasswordRequest();
          if (failure) reject(failure);
          else resolve();
        }
        function onAbort() { finish(passwordFailure("密码登录已取消")); }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        passwordRequest = request;
        notifyPasswordRequest();
      });
    }

    async function callApi(method, params) {
      if (method !== "terminal.open") return postApi(method, params);
      if (passwordDisposed) throw passwordFailure("密码登录已取消");
      const controller = new AbortController();
      passwordControllers.add(controller);
      try {
        try {
          const result = await postApi(method, params, controller.signal);
          if (passwordDisposed || controller.signal.aborted) throw passwordFailure("密码登录已取消");
          return result;
        } catch (failure) {
          if (controller.signal.aborted) throw passwordFailure("密码登录已取消");
          if (!failure || failure.code !== "AUTH") throw failure;
        }
        await requestPassword(params.name, controller);
        if (passwordDisposed || controller.signal.aborted) throw passwordFailure("密码登录已取消");
        // Exactly one retry after explicit successful authentication.
        try {
          const result = await postApi(method, params, controller.signal);
          if (passwordDisposed || controller.signal.aborted) throw passwordFailure("密码登录已取消");
          return result;
        } catch (failure) {
          throw passwordFailure("认证后终端连接失败，请重新连接后再试");
        }
      } finally {
        passwordControllers.delete(controller);
      }
    }

    async function postApi(method, params, signal) {
      const response = await fetch(API_URL, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ method: method }, params || {})),
        signal: signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const message =
          payload && payload.error && payload.error.message
            ? payload.error.message
            : "HTTP " + response.status;
        const failure = new Error(message);
        if (payload && payload.error && typeof payload.error.code === "string") {
          failure.code = payload.error.code;
        }
        throw failure;
      }
      return payload.result;
    }

    function formatTime(time) {
      if (typeof time !== "number" || !Number.isFinite(time)) return "—";
      const date = new Date(time);
      const pad = (value) => String(value).padStart(2, "0");
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    function statusLabel(status) {
      if (!status || status.kind !== "exited") return "运行中";
      return "已退出 " + (status.exitCode === null ? status.signal || "?" : status.exitCode);
    }

    function riskClass(risk) {
      if (risk === "high") return "dshr-risk-high";
      if (risk === "write") return "dshr-risk-write";
      if (risk === "gray") return "dshr-risk-gray";
      return "dshr-risk-low";
    }

    // ---------------------------------------------------------------------
    // Live terminal mirror (v0.4) — shared feed
    //
    // One EventSource per browser page feeds every mounted terminal panel and
    // the plugin-level auto-opener. `notify` coalesces React renders; raw start
    // events reach the auto-opener synchronously.
    // ---------------------------------------------------------------------

    let liveFlagsPromise = null;

    /**
     * Read `result.live` from the overview API once. Failures assume the enabled
     * defaults so a transient network error never disables the panel.
     * @returns {Promise<{enabled: boolean, autoOpen: boolean, devEvents: boolean}>}
     */
    function loadLiveFlags() {
      if (liveFlagsPromise === null) {
        liveFlagsPromise = callApi("overview").then(
          function readFlags(result) {
            const live = result && result.live;
            if (live === null || typeof live !== "object") {
              return { enabled: true, autoOpen: true, devEvents: false };
            }
            return {
              enabled: live.enabled !== false,
              autoOpen: live.autoOpen !== false,
              devEvents: live.devEvents === true,
            };
          },
          function fallback() {
            return { enabled: true, autoOpen: true, devEvents: false };
          },
        );
      }
      return liveFlagsPromise;
    }

    function snapshotToCommand(raw) {
      if (raw === null || typeof raw !== "object" || typeof raw.id !== "string") return null;
      const status = raw.status === "error" ? "error" : raw.status === "done" ? "done" : "running";
      return {
        id: raw.id,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
        tool: typeof raw.tool === "string" ? raw.tool : "remote",
        host: typeof raw.host === "string" ? raw.host : "—",
        kind: typeof raw.kind === "string" ? raw.kind : "exec",
        command: typeof raw.command === "string" ? raw.command : "",
        time: typeof raw.time === "number" ? raw.time : 0,
        status: status,
        output: typeof raw.output === "string" ? raw.output : "",
        code: typeof raw.code === "number" ? raw.code : undefined,
        error: typeof raw.error === "string" ? raw.error : undefined,
        durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
      };
    }

    /** Keep the retained scrollback bounded (oldest tail dropped first). */
    function trimLiveState(state) {
      for (const command of state.commands) {
        if (command.output.length > LIVE_MAX_COMMAND_OUTPUT) {
          const dropped = command.output.length - LIVE_MAX_COMMAND_OUTPUT;
          command.output = command.output.slice(dropped);
          state.totalOutput -= dropped;
        }
      }
      while (state.commands.length > LIVE_MAX_COMMANDS) {
        const dropped = state.commands.shift();
        state.totalOutput -= dropped.output.length;
      }
      while (state.totalOutput > LIVE_MAX_TOTAL_OUTPUT && state.commands.length > 1) {
        const oldest = state.commands[0];
        if (oldest.output.length === 0) {
          state.commands.shift();
          continue;
        }
        state.totalOutput -= oldest.output.length;
        oldest.output = "";
      }
      if (state.totalOutput < 0) state.totalOutput = 0;
    }

    /**
     * The EventSource-backed live command store shared by every panel instance.
     * Frames mirror the Host SSE contract documented in docs/ARCHITECTURE.md:
     * `snapshot`, `start`, `output`, `end`, `clear`.
     */
    function createLiveFeed() {
      const state = {
        connection: "idle",
        commands: [],
        totalOutput: 0,
        version: 0,
      };
      const listeners = new Set();
      const eventListeners = new Set();
      let source = null;
      let started = false;
      /** Local Clear: snapshots older than this stay hidden after a reconnect. */
      let localClearedAt = 0;
      let notifyScheduled = false;

      function emitEvent(event) {
        for (const listener of [...eventListeners]) {
          try {
            listener(event);
          } catch (error) {
            try {
              console.warn("[dsh-remote] live event listener failed", error);
            } catch {
              /* ignore */
            }
          }
        }
      }

      function notify() {
        if (notifyScheduled) return;
        notifyScheduled = true;
        const flush = function flush() {
          notifyScheduled = false;
          state.version += 1;
          for (const listener of [...listeners]) {
            try {
              listener(state);
            } catch (error) {
              try {
                console.warn("[dsh-remote] live feed listener failed", error);
              } catch {
                /* ignore */
              }
            }
          }
        };
        if (typeof setTimeout === "function") setTimeout(flush, LIVE_NOTIFY_MS);
        else flush();
      }

      function findCommand(id) {
        for (const command of state.commands) {
          if (command.id === id) return command;
        }
        return undefined;
      }

      function applyFrame(frame) {
        if (frame === null || typeof frame !== "object") return;
        switch (frame.type) {
          case "snapshot": {
            const list = Array.isArray(frame.commands) ? frame.commands : [];
            state.commands = [];
            state.totalOutput = 0;
            for (const raw of list) {
              const command = snapshotToCommand(raw);
              if (command === null) continue;
              if (command.time <= localClearedAt) continue;
              state.commands.push(command);
              state.totalOutput += command.output.length;
            }
            trimLiveState(state);
            notify();
            break;
          }
          case "start": {
            if (typeof frame.id !== "string") break;
            if (typeof frame.time === "number" && frame.time <= localClearedAt) break;
            const existing = findCommand(frame.id);
            const command = {
              id: frame.id,
              sessionId: typeof frame.sessionId === "string" ? frame.sessionId : null,
              tool: typeof frame.tool === "string" ? frame.tool : "remote",
              host: typeof frame.host === "string" ? frame.host : "—",
              kind: typeof frame.kind === "string" ? frame.kind : "exec",
              command: typeof frame.command === "string" ? frame.command : "",
              time: typeof frame.time === "number" ? frame.time : Date.now(),
              status: "running",
              output: "",
              code: undefined,
              error: undefined,
              durationMs: undefined,
            };
            if (existing === undefined) {
              state.commands.push(command);
            } else {
              state.totalOutput -= existing.output.length;
              command.output = existing.output;
              state.commands[state.commands.indexOf(existing)] = command;
              state.totalOutput += command.output.length;
            }
            trimLiveState(state);
            notify();
            break;
          }
          case "output": {
            if (typeof frame.id !== "string" || typeof frame.text !== "string") break;
            const command = findCommand(frame.id);
            if (command === undefined || frame.text.length === 0) break;
            command.output += frame.text;
            state.totalOutput += frame.text.length;
            trimLiveState(state);
            notify();
            break;
          }
          case "end": {
            if (typeof frame.id !== "string") break;
            const command = findCommand(frame.id);
            if (command === undefined) break;
            const failed =
              frame.error !== undefined && frame.error !== null || frame.status === "error";
            command.status = failed ? "error" : "done";
            command.code = typeof frame.code === "number" ? frame.code : undefined;
            command.error =
              frame.error === undefined || frame.error === null ? undefined : String(frame.error);
            command.durationMs = typeof frame.durationMs === "number" ? frame.durationMs : undefined;
            notify();
            break;
          }
          case "clear": {
            state.commands = [];
            state.totalOutput = 0;
            notify();
            break;
          }
          default:
            break;
        }
        emitEvent(frame);
      }

      function connect() {
        if (typeof EventSource === "undefined") {
          state.connection = "closed";
          notify();
          return;
        }
        state.connection = "connecting";
        notify();
        let next;
        try {
          next = new EventSource(LIVE_URL, { withCredentials: true });
        } catch (error) {
          state.connection = "closed";
          notify();
          return;
        }
        source = next;
        next.onopen = function onopen() {
          if (source !== next) return;
          state.connection = "connected";
          notify();
        };
        next.onmessage = function onmessage(event) {
          if (source !== next) return;
          let frame = null;
          try {
            frame = JSON.parse(event.data);
          } catch (error) {
            frame = null;
          }
          if (frame !== null) applyFrame(frame);
        };
        next.onerror = function onerror() {
          if (source !== next) return;
          state.connection = next.readyState === 2 ? "closed" : "reconnecting";
          notify();
        };
      }

      function disconnect() {
        if (source !== null) {
          try {
            source.close();
          } catch {
            /* ignore */
          }
          source = null;
        }
      }

      function ensureStarted() {
        if (started) return;
        started = true;
        connect();
      }

      return {
        ensureStarted: ensureStarted,
        reconnect: function reconnect() {
          disconnect();
          started = false;
          state.connection = "reconnecting";
          notify();
          ensureStarted();
        },
        dispose: function dispose() {
          disconnect();
          started = false;
        },
        subscribe: function subscribe(listener) {
          listeners.add(listener);
          return function unsubscribe() {
            listeners.delete(listener);
          };
        },
        subscribeEvents: function subscribeEvents(listener) {
          eventListeners.add(listener);
          return function unsubscribe() {
            eventListeners.delete(listener);
          };
        },
        getSnapshot: function getSnapshot() {
          return state;
        },
        /**
         * Clear the rendered log locally. The management API has no `live.clear`
         * method, so the Host hub is untouched; a later snapshot cannot resurrect
         * the commands that were on screen when Clear was pressed.
         */
        clearLocal: function clearLocal() {
          localClearedAt = Date.now();
          state.commands = [];
          state.totalOutput = 0;
          notify();
        },
      };
    }

    const liveFeed = createLiveFeed();

    function sessionShort(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return "—";
      return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
    }

    function liveConnectionLabel(connection, flags) {
      if (flags !== null && flags.enabled === false) return "未启用";
      if (connection === "connected") return "已连接";
      if (connection === "reconnecting") return "重连中";
      if (connection === "closed") return "已断开";
      return "连接中";
    }

    function liveStatusLine(command) {
      if (command.status === "running") return "[running]";
      if (command.status === "error") {
        return "[error: " + (command.error ? command.error : "failed") + "]";
      }
      const code = typeof command.code === "number" ? command.code : "?";
      const duration =
        typeof command.durationMs === "number" ? " · " + command.durationMs + "ms" : "";
      return "[exit " + code + duration + "]";
    }

    // ---------------------------------------------------------------------
    // Remote Ops management page (v0.3)
    // ---------------------------------------------------------------------

    function RemoteOpsIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("rect", { x: 2.5, y: 4, width: 13, height: 10, rx: 1.6 }),
        h("path", { d: "M5.5 8.5l2 1.6-2 1.6" }),
        h("path", { d: "M9.5 11.7h3" }),
        h("path", { d: "M18 9.5c2 0 3.5 1.4 3.5 3.4v1.3" }),
        h("rect", { x: 17, y: 14.5, width: 5, height: 3.6, rx: 0.9 }),
        h("path", { d: "M5 18h9" }),
      );
    }

    function Card(props) {
      return h(
        "section",
        { className: "dshr-card" },
        h("div", { className: "dshr-card-head" }, h("span", null, props.title), props.extra || null),
        h("div", { className: "dshr-card-body" }, props.children),
      );
    }

    // ---------------------------------------------------------------------
    // v0.5 shared UI: inline notice, Escape-dismissable modal shell, host form,
    // per-host audit viewer and the delete confirmation.
    // ---------------------------------------------------------------------

    /**
     * Copy `text` to the clipboard: `navigator.clipboard` first, then a transient
     * textarea + `document.execCommand("copy")` fallback. The textarea is attached
     * to the component's own notice element (never appended to document.body) and
     * removed immediately.
     *
     * @param {string} text Text to copy.
     * @param {Element | null} anchor Clicked element the fallback textarea hangs off.
     * @returns {Promise<boolean>} Whether the copy succeeded.
     */
    async function copyTextToClipboard(text, anchor) {
      if (typeof text !== "string" || text.length === 0) return false;
      try {
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard !== null &&
          navigator.clipboard !== undefined &&
          typeof navigator.clipboard.writeText === "function"
        ) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        /* fall through to the execCommand fallback */
      }
      if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
      const parent =
        anchor !== null && anchor !== undefined && anchor.parentElement !== null && anchor.parentElement !== undefined
          ? anchor.parentElement
          : null;
      if (parent === null) return false;
      let holder = null;
      try {
        holder = document.createElement("textarea");
        holder.value = text;
        holder.setAttribute("readonly", "");
        holder.style.position = "fixed";
        holder.style.top = "-1000px";
        holder.style.left = "-1000px";
        holder.style.opacity = "0";
        parent.appendChild(holder);
        holder.select();
        if (typeof holder.setSelectionRange === "function") holder.setSelectionRange(0, text.length);
        return document.execCommand("copy") === true;
      } catch (error) {
        return false;
      } finally {
        if (holder !== null && holder.parentElement !== null) {
          try {
            holder.parentElement.removeChild(holder);
          } catch (error) {
            /* ignore */
          }
        }
      }
    }

    /**
     * Build the inline error notice for a failed action. An attach failure
     * (`terminal.open` succeeded but the bridge never reached the relay) carries
     * the shell command plus the bridge-log hint so the notice renders 复制命令.
     *
     * @param {string} prefix e.g. "连接失败：".
     * @param {any} failure Thrown value.
     * @returns {{kind: string, text: string, command?: string, hint?: string}}
     */
    function noticeForFailure(prefix, failure) {
      const notice = { kind: "error", text: prefix + errorText(failure) };
      if (failure !== null && failure !== undefined && failure.attachFailure === true) {
        if (typeof failure.noticeText === "string" && failure.noticeText.length > 0) {
          notice.text = prefix + failure.noticeText;
        }
        if (typeof failure.command === "string" && failure.command.length > 0) notice.command = failure.command;
        notice.hint = typeof failure.hint === "string" && failure.hint.length > 0 ? failure.hint : BRIDGE_LOG_HINT;
      }
      return notice;
    }

    /**
     * Inline notice/toast for connect/inject failures and status messages.
     * v0.5.1: an attach-failure notice also renders the launch command in a
     * monospace block, a 复制命令 button and the bridge-log hint. The root
     * `[data-dsh-remote-notice]` keeps its `data-kind` contract.
     */
    function RemoteNotice(props) {
      const notice = props.notice;
      const command =
        notice !== null && notice !== undefined && typeof notice.command === "string" && notice.command.length > 0
          ? notice.command
          : null;
      const hint =
        notice !== null && notice !== undefined && typeof notice.hint === "string" && notice.hint.length > 0
          ? notice.hint
          : null;
      const [copyState, setCopyState] = React.useState("idle");
      React.useEffect(
        function resetCopyState() {
          setCopyState("idle");
        },
        [command],
      );
      React.useEffect(
        function clearCopyFeedback() {
          if (copyState === "idle") return undefined;
          const timer = setTimeout(function reset() {
            setCopyState("idle");
          }, 2_000);
          return function cleanup() {
            clearTimeout(timer);
          };
        },
        [copyState],
      );
      if (notice === null || notice === undefined) return null;
      const kind = notice.kind === "error" ? "error" : "info";
      function onCopy(event) {
        const anchor = event !== null && event !== undefined ? event.currentTarget : null;
        copyTextToClipboard(command, anchor).then(function copied(ok) {
          setCopyState(ok ? "copied" : "failed");
        });
      }
      const commandBlock =
        command !== null
          ? h(
              "div",
              { className: "dshr-notice-command-block" },
              h(
                "pre",
                { className: "dshr-notice-command", "data-dsh-remote-notice-command": "" },
                command,
              ),
              h(
                "div",
                { className: "dshr-notice-actions" },
                h(
                  "button",
                  {
                    className: "dshr-btn dshr-btn-sm",
                    type: "button",
                    "data-dsh-remote-notice-action": "copy",
                    onClick: onCopy,
                    title: "复制完整启动命令",
                  },
                  copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制命令",
                ),
                hint !== null
                  ? h("span", { className: "dshr-notice-hint", "data-dsh-remote-notice-hint": "" }, hint)
                  : null,
              ),
            )
          : hint !== null
            ? h("span", { className: "dshr-notice-hint", "data-dsh-remote-notice-hint": "" }, hint)
            : null;
      return h(
        "div",
        {
          className: "dshr-notice dshr-notice-" + kind,
          "data-dsh-remote-notice": kind,
          "data-kind": kind,
          role: kind === "error" ? "alert" : "status",
        },
        h(
          "div",
          { className: "dshr-notice-body" },
          h("span", { className: "dshr-notice-text" }, notice.text),
          commandBlock,
        ),
        typeof props.onDismiss === "function"
          ? h(
              "button",
              { className: "dshr-notice-close", type: "button", onClick: props.onDismiss, "aria-label": "关闭提示" },
              "×",
            )
          : null,
      );
    }

    /**
     * The value the full-detail viewer/export shows: `detailFull` when the Host
     * returns it (`audit.list {full: true}`), else the one-line `detail`.
     *
     * @param {any} entry AuditEntry.
     * @returns {string}
     */
    function auditEntryFullDetail(entry) {
      if (entry === null || entry === undefined) return "";
      if (typeof entry.detailFull === "string" && entry.detailFull.length > 0) return entry.detailFull;
      if (typeof entry.detail === "string") return entry.detail;
      return "";
    }

    /** Transport success and verified operation success are intentionally distinct. */
    function auditOutcomeLabel(outcome) {
      const labels = { ok: "成功", error: "错误", failed: "执行失败", denied: "已拒绝",
        cancelled: "已取消", timeout: "超时", timed_out: "超时", unknown: "结果未知",
        verification_failed: "验证未通过", "verification-failed": "验证未通过",
        "validation-failed": "验证未通过", validation_failed: "验证未通过" };
      return labels[outcome] || outcome || "结果未知";
    }
    function auditOutcomeClass(outcome) {
      if (outcome === "ok") return "dshr-ok";
      if (["denied", "cancelled", "timeout", "timed_out", "unknown"].indexOf(outcome) !== -1) return "dshr-warn";
      return "dshr-fail";
    }
    function auditRecoveryDetails(entry) {
      const fields = ["operationId", "callId", "rootCallId", "sessionId", "agentId", "exitCode", "summary", "backupId", "beforeVersion", "afterVersion", "verification", "writeAttempted", "truncated", "targetEvidence"];
      return fields.filter(function present(key) { return entry[key] !== undefined; })
        .map(function line(key) { return key + ": " + (entry[key] === null ? "unknown" : typeof entry[key] === "object" ? JSON.stringify(entry[key]) : String(entry[key])); }).join("\n");
    }
    function auditHealthNotice(health) {
      if (!health) return null;
      const degraded = health.status === "degraded" || health.status === "unknown" || health.ok === false || (!health.status && Number(health.failedWrites) > 0);
      const memoryOnly = health.status === "memory-only" || health.persistent === false;
      if (!degraded && !memoryOnly) return null;
      return h("div", { className: degraded ? "dshr-error" : "dshr-hint", role: "status", "aria-live": "polite", "data-audit-health": health.status || "degraded" },
        degraded ? "审计持久化异常：部分记录可能未写入磁盘，请检查存储权限和容量；恢复后刷新确认。" : "审计仅保存在内存中，重启后将丢失。",
        health.lastError ? " " + health.lastError : "");
    }

    /** One audit entry as a plain export object with guaranteed detail strings. */
    function normalizeAuditEntry(entry) {
      const source = entry !== null && entry !== undefined && typeof entry === "object" ? entry : {};
      const detail =
        typeof source.detail === "string"
          ? source.detail
          : source.detail === null || source.detail === undefined
            ? ""
            : String(source.detail);
      const detailFull = typeof source.detailFull === "string" ? source.detailFull : detail;
      return Object.assign({}, source, { detail: detail, detailFull: detailFull });
    }

    /** Bounded paginated export, rejecting a changing trail rather than silently omitting rows. */
    async function readAuditPages(requestPage, host) {
      const base = { limit: AUDIT_EXPORT_LIMIT, full: true };
      if (host) base.host = host;
      const first = await requestPage(base);
      const total = Number.isSafeInteger(first.total) ? first.total : (first.entries || []).length;
      if (total > 10000) throw new Error("导出最多支持 10000 条记录，请缩小主机范围或使用受控归档。");
      const keyOf = function key(entry) { return entry.operationId || [entry.time, entry.id, entry.tool, entry.host].join(":"); };
      const rows = Array.isArray(first.entries) ? first.entries.slice() : [];
      let offset = rows.length;
      while (offset < total) {
        const page = await requestPage(Object.assign({}, base, { offset: offset }));
        if (!Array.isArray(page.entries) || page.entries.length === 0) throw new Error("审计记录在导出期间发生变化，请重试。");
        rows.push.apply(rows, page.entries);
        offset += page.entries.length;
      }
      const unique = new Map(rows.map(function row(entry) { return [keyOf(entry), entry]; }));
      if (total) {
        const check = await requestPage(Object.assign({}, base, { limit: 1 }));
        if (check.total !== total || !check.entries || !check.entries[0] || keyOf(check.entries[0]) !== keyOf(rows[0]) || unique.size !== total) {
          throw new Error("审计记录在导出期间发生变化，请重试。");
        }
      }
      return Array.from(unique.values());
    }
    function readAuditExport(host) {
      return readAuditPages(function request(params) { return callApi("audit.list", params); }, host);
    }

    /** Quote one CSV field (RFC 4180: always quoted, internal quotes doubled). */
    function csvField(value) {
      const text = value === null || value === undefined ? "" : String(value);
      return '"' + text.replace(/"/g, '""') + '"';
    }

    /** Columns of the CSV export (the JSON/TXT exports keep every entry field). */
    const AUDIT_EXPORT_COLUMNS = [
      "time",
      "tool",
      "host",
      "action",
      "risk",
      "outcome",
      "durationMs",
      "detail",
      "detailFull",
      "operationId", "callId", "rootCallId", "sessionId", "agentId", "exitCode", "summary",
      "backupId", "beforeVersion", "afterVersion", "verification", "writeAttempted", "timedOut", "truncated", "targetEvidence",
    ];

    const AUDIT_EXPORT_MIME = {
      json: "application/json;charset=utf-8",
      csv: "text/csv;charset=utf-8",
      txt: "text/plain;charset=utf-8",
    };

    /** `YYYYMMDD-HHmmss` local timestamp used in export filenames. */
    function auditExportTimestamp() {
      const date = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      return (
        date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" +
        pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
      );
    }

    /** `dsh-remote-audit-<timestamp>.<json|csv|txt>` (the v0.5.1 contract name). */
    function auditExportFilename(format) {
      return "dsh-remote-audit-" + auditExportTimestamp() + "." + format;
    }

    /**
     * Serialize audit entries for one export format.
     * JSON: a plain array (each entry keeps all fields + string detail/detailFull).
     * CSV: RFC 4180 with every field quoted and quotes doubled.
     * TXT: one readable block per entry with the full command preserved.
     */
    function auditExportText(format, entries) {
      const list = (Array.isArray(entries) ? entries : []).map(normalizeAuditEntry);
      if (format === "csv") {
        const lines = [AUDIT_EXPORT_COLUMNS.join(",")];
        for (const entry of list) {
          lines.push(
            AUDIT_EXPORT_COLUMNS.map(function column(key) {
              return csvField(typeof entry[key] === "object" && entry[key] !== null ? JSON.stringify(entry[key]) : entry[key]);
            }).join(","),
          );
        }
        return lines.join("\r\n") + "\r\n";
      }
      if (format === "txt") {
        if (list.length === 0) return "（没有审计记录）\n";
        const blocks = list.map(function block(entry, index) {
          const time =
            typeof entry.time === "number" && Number.isFinite(entry.time)
              ? new Date(entry.time).toISOString()
              : "—";
          const duration =
            typeof entry.durationMs === "number" ? entry.durationMs + "ms" : "—";
          return [
            "#" + (index + 1) + " " + time,
            "tool: " + (entry.tool === undefined || entry.tool === null ? "—" : entry.tool),
            "host: " + (entry.host === undefined || entry.host === null ? "—" : entry.host),
            "action: " + (entry.action === undefined || entry.action === null ? "—" : entry.action),
            "risk: " + (entry.risk === undefined || entry.risk === null ? "—" : entry.risk) +
              "  outcome: " + (entry.outcome === undefined || entry.outcome === null ? "—" : entry.outcome) +
              "  duration: " + duration,
            "detail: " + entry.detail,
            "detailFull:",
            auditEntryFullDetail(entry),
            auditRecoveryDetails(entry),
          ].filter(Boolean).join("\n");
        });
        return blocks.join("\n\n") + "\n";
      }
      return JSON.stringify(list, null, 2) + "\n";
    }

    /**
     * Download `text` through a Blob URL. The transient anchor is appended to the
     * calling component's own element (no document.body overlay) and removed at
     * once; the object URL is revoked on the next tick.
     *
     * @returns {boolean} Whether the download was started.
     */
    function downloadTextFile(hostElement, filename, text, mime) {
      if (typeof document === "undefined") return false;
      if (hostElement === null || hostElement === undefined || typeof hostElement.appendChild !== "function") return false;
      let blob;
      try {
        blob = new Blob([text], { type: mime });
      } catch (error) {
        return false;
      }
      const url =
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
      if (url === null) return false;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      hostElement.appendChild(anchor);
      try {
        anchor.click();
      } catch (error) {
        /* the caller reports that no download started */
      }
      if (anchor.parentElement !== null) anchor.parentElement.removeChild(anchor);
      setTimeout(function revoke() {
        try {
          URL.revokeObjectURL(url);
        } catch (error) {
          /* ignore */
        }
      }, 10_000);
      return true;
    }

    /** Write one audit export (json/csv/txt) through the component's DOM anchor host. */
    function writeAuditExport(hostElement, format, entries) {
      const selected =
        typeof format === "string" && Object.prototype.hasOwnProperty.call(AUDIT_EXPORT_MIME, format)
          ? format
          : "json";
      return downloadTextFile(
        hostElement,
        auditExportFilename(selected),
        auditExportText(selected, entries),
        AUDIT_EXPORT_MIME[selected],
      );
    }

    /** Close a modal on Escape (captured before the page's own key handling). */
    function useEscape(active, onClose) {
      React.useEffect(function bindEscape() {
        if (active !== true) return undefined;
        function onKeyDown(event) {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (typeof document === "undefined") return undefined;
        document.addEventListener("keydown", onKeyDown, true);
        return function unbind() {
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [active, onClose]);
    }

    /** One scrollable, keyboard-dismissable modal frame owned by this plugin. */
    function ModalShell(props) {
      useEscape(true, props.onClose);
      const dialogRef = React.useRef(null);
      React.useEffect(function trapDialogFocus() {
        if (props.trapFocus !== true || typeof document === "undefined") return undefined;
        const dialog = dialogRef.current;
        if (dialog === null) return undefined;
        const previous = document.activeElement;
        function focusables() {
          return [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
        }
        function focusFirst() {
          const first = focusables()[0];
          (first || dialog).focus();
        }
        function onFocus(event) {
          if (!dialog.contains(event.target)) focusFirst();
        }
        function onTab(event) {
          if (event.key !== "Tab") return;
          const elements = focusables();
          const first = elements[0];
          const last = elements[elements.length - 1];
          if (!first) { event.preventDefault(); dialog.focus(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
          }
        }
        focusFirst();
        document.addEventListener("focusin", onFocus, true);
        document.addEventListener("keydown", onTab, true);
        return function releaseFocus() {
          document.removeEventListener("focusin", onFocus, true);
          document.removeEventListener("keydown", onTab, true);
          if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus();
        };
      }, [props.trapFocus]);
      return h(
        "div",
        {
          className: "dshr-modal-layer",
          style: props.layerStyle,
          onMouseDown: function backdrop(event) {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          "div",
          Object.assign(
            {
              className: "dshr-modal" + (props.wide === true ? " dshr-modal-wide" : ""),
              ref: dialogRef,
              tabIndex: props.trapFocus === true ? -1 : undefined,
              role: "dialog",
              "aria-modal": "true",
              "aria-label": props.title,
            },
            props.rootAttrs || {},
          ),
          h(
            "header",
            { className: "dshr-modal-head" },
            h("span", { className: "dshr-modal-title" }, props.title),
            props.headExtra || null,
          ),
          h("div", { className: "dshr-modal-body" }, props.children),
          props.footer ? h("footer", { className: "dshr-modal-foot" }, props.footer) : null,
        ),
      );
    }

    /** Root-scoped so conversation navigation never unmounts a password prompt. */
    function PasswordOverlay() {
      const [request, setRequest] = React.useState(function initial() { return passwordRequest; });
      const [, redraw] = React.useState(0);
      React.useEffect(function subscribe() {
        const unsubscribe = subscribePasswordRequest(function changed(value) {
          setRequest(value);
          redraw(function increment(count) { return count + 1; });
        });
        setRequest(passwordRequest);
        return function cleanup() {
          unsubscribe();
          if (passwordRequest !== null) passwordRequest.cancel();
        };
      }, []);
      return request === null ? null : h(PasswordDialog, { key: request.name, request: request });
    }

    function PasswordDialog(props) {
      const request = props.request;
      const inputRef = React.useRef(null);
      React.useEffect(function inputLifetime() {
        const input = inputRef.current;
        function clear() { if (input !== null) input.value = ""; }
        request.clearInput = clear;
        return function cleanup() {
          clear();
          request.clearInput = null;
          // The root overlay owns cancellation; this cleanup also runs during
          // React's development effect replay and must only erase the input.
        };
      }, [request]);
      function submit(event) {
        event.preventDefault();
        if (request.busy || inputRef.current === null) return;
        let password = inputRef.current.value;
        inputRef.current.value = "";
        void request.submit(password);
        password = "";
      }
      return h(ModalShell, {
        title: "SSH 密码登录",
        onClose: request.cancel,
        trapFocus: true,
        layerStyle: { position: "fixed", inset: 0, pointerEvents: "auto", zIndex: 100 },
        rootAttrs: { "aria-describedby": "dshr-auth-description", "aria-busy": request.busy },
      }, h("form", { onSubmit: submit, autoComplete: "off" },
        h("p", { id: "dshr-auth-description", className: "dshr-form-note" },
          "连接 " + request.name + " 需要 SSH 密码。密码仅提交给 Host，并仅保存在 Host 内存中；不会写入对话或操作记录。"),
        h("label", { className: "dshr-field", htmlFor: "dshr-auth-password" },
          h("span", { className: "dshr-field-label" }, "SSH 密码"),
          h("input", {
            id: "dshr-auth-password", ref: inputRef, className: "dshr-input",
            type: "password", required: true, disabled: request.busy,
            autoComplete: "off", "aria-describedby": "dshr-auth-description",
          })),
        h("p", { role: "status", "aria-live": "polite", className: "dshr-form-note" },
          request.busy ? "正在验证密码…" : "验证失败后需要重新连接，不会自动重试密码。"),
        h("div", { className: "dshr-modal-actions" },
          h("button", { type: "button", className: "dshr-btn", onClick: request.cancel }, "取消"),
          h("button", { type: "submit", className: "dshr-btn dshr-btn-primary", disabled: request.busy },
            request.busy ? "验证中…" : "登录并连接"))));
    }

    /** Comma-separated field -> trimmed non-empty list (proxyJump/tags). */
    function splitList(value) {
      return String(value || "")
        .split(",")
        .map(function trim(entry) {
          return entry.trim();
        })
        .filter(function nonEmpty(entry) {
          return entry.length > 0;
        });
    }

    /** Editable fields of a managed host, in display order. */
    const HOST_FORM_FIELDS = [
      { key: "name", label: "名称", placeholder: "prod-web-1", hint: "唯一标识，工具与对话里都用它", required: true },
      { key: "host", label: "主机地址", placeholder: "10.0.0.11", hint: "主机名或 IP，不带用户名", required: true },
      { key: "port", label: "端口", placeholder: "22", type: "number", hint: "默认 22" },
      { key: "username", label: "登录用户", placeholder: "ops", hint: "留空时用当前系统用户" },
      { key: "identityFile", label: "私钥路径", placeholder: "~/.ssh/prod_ed25519", hint: "只填路径，不粘贴私钥内容" },
      { key: "passwordEnv", label: "密码环境变量", placeholder: "PROD_WEB_PASSWORD", hint: "环境变量名称，不是密码本身" },
      { key: "passphraseEnv", label: "私钥口令环境变量", placeholder: "PROD_KEY_PASSPHRASE", hint: "环境变量名称，不是口令本身" },
      { key: "proxyJump", label: "跳板机", placeholder: "bastion.example.com", hint: "逗号分隔，格式 [user@]host[:port]" },
      { key: "tags", label: "标签", placeholder: "prod, web", hint: "逗号分隔，最多 16 个" },
    ];

    const ACTION_TYPES = ["command", "text", "key", "wait", "delay"];
    const ACTION_KEYS = ["Enter", "Tab", "Escape", "Ctrl-C", "Ctrl-D", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"];

    function newAction(type) {
      return type === "delay" ? { type: type, durationMs: 1000 } : { type: type, value: type === "key" ? "Enter" : "" };
    }

    /** Copy authoritative action data; legacy migration keeps root-on-target checking. */
    function hostActions(host) {
      if (Array.isArray(host.actions)) return host.actions.map(function copy(action) { return Object.assign({}, action); });
      const legacy = typeof host.loginCommand === "string" ? /^sww -r -u ([A-Za-z0-9][A-Za-z0-9._-]{0,63}) ([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(host.loginCommand) : null;
      return legacy ? [{ type: "command", value: host.loginCommand, expectCluster: legacy[2] }] : [newAction("command")];
    }

    /** Editor convenience validation only; the Host remains the policy/validation authority. */
    function buildActionInput(rows) {
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32) throw new Error("终端动作必须有 1–32 步");
      return rows.map(function validate(row, index) {
        const fail = function fail(message) { throw new Error("第 " + (index + 1) + " 步：" + message); };
        if (!row || !ACTION_TYPES.includes(row.type)) fail("请选择有效动作类型");
        const fields = row.type === "delay" ? ["durationMs"] : row.type === "wait" ? ["value", "timeoutMs"] : ["value", "expect", "timeoutMs"].concat(row.type === "command" ? ["expectCluster"] : []);
        if (Object.keys(row).some(function unknown(key) { return !["type", "label"].concat(fields).includes(key); })) fail("包含未知字段或凭据字段");
        const result = { type: row.type };
        if (row.label !== undefined && row.label !== "") {
          if (typeof row.label !== "string" || row.label.length > 80 || /[\x00-\x1f\x7f]/.test(row.label)) fail("标签须为 1–80 位可打印文字");
          result.label = row.label;
        }
        if (row.type === "delay") {
          const duration = (typeof row.durationMs === "number" || typeof row.durationMs === "string" && row.durationMs.trim() !== "") ? Number(row.durationMs) : NaN;
          if (!Number.isInteger(duration) || duration < 0 || duration > 120000) fail("延迟须为 0–120000 毫秒整数");
          result.durationMs = duration;
        } else {
          if (typeof row.value !== "string" || row.value.length === 0) fail("请填写动作内容");
          if (row.type === "key") {
            if (!ACTION_KEYS.includes(row.value)) fail("请选择支持的按键");
          } else if (row.type === "wait") {
            if (row.value.length > 2048 || /[\x00\x1b]/.test(row.value)) fail("等待文字须为 1–2048 位，不含 NUL/ESC");
          } else if (row.value.length > 4096 || /[\x00-\x1f\x7f]/.test(row.value)) fail("输入须为 1–4096 位单行文字，不含控制字符");
          result.value = row.value;
          if (row.expect !== undefined && row.expect !== "") {
            if (typeof row.expect !== "string" || row.expect.length > 2048 || /[\x00\x1b]/.test(row.expect)) fail("预期输出须为 1–2048 位文字，不含 NUL/ESC");
            result.expect = row.expect;
          }
          if (row.expectCluster !== undefined && row.expectCluster !== "") {
            if (typeof row.expectCluster !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.expectCluster)) fail("目标集群名称不安全");
            if (result.expect !== undefined) fail("目标 root 提示符与预期输出不能同时设置");
            result.expectCluster = row.expectCluster;
          }
          if (row.timeoutMs !== undefined && row.timeoutMs !== "") {
            const timeout = (typeof row.timeoutMs === "number" || typeof row.timeoutMs === "string" && row.timeoutMs.trim() !== "") ? Number(row.timeoutMs) : NaN;
            if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) fail("超时须为 100–120000 毫秒整数");
            result.timeoutMs = timeout;
          }
        }
        return result;
      });
    }

    function reorderActions(rows, index, offset) {
      const next = rows.slice();
      const target = index + offset;
      if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return next;
      const row = next.splice(index, 1)[0];
      next.splice(target, 0, row);
      return next;
    }

    /** Only the documented safe progress fields may reach the view. */
    function actionProgressText(progress) {
      if (!progress || !["waiting-entry", "running", "completed", "failed", "cancelled"].includes(progress.state)) return "";
      const total = progress.total;
      if (!Number.isInteger(total) || total < 1 || total > 32 || !Number.isInteger(progress.completed) || progress.completed < 0 || progress.completed > total) return "";
      const done = progress.completed;
      if (progress.state === "completed") return done === total && progress.index === total ? "终端动作已完成 · " + done + "/" + total : "";
      if (progress.state === "waiting-entry") return "等待入口 SSH 提示符 · 0/" + total;
      if (progress.state === "failed" || progress.state === "cancelled") return (progress.state === "failed" ? "终端动作失败" : "终端动作已取消") + " · " + done + "/" + total + "，后续动作已停止；不会自动重试";
      if (!Number.isInteger(progress.index) || progress.index < 0 || progress.index >= total) return "";
      const type = ACTION_TYPES.includes(progress.type) ? " · " + progress.type : "";
      const label = typeof progress.label === "string" && progress.label.length <= 80 && !/[\x00-\x1f\x7f]/.test(progress.label) ? " · " + progress.label : "";
      return "执行第 " + (progress.index + 1) + "/" + total + " 步" + type + label + "（已完成 " + done + "）";
    }

    function renderActionEditor(props) {
      const rows = props.actions;
      function patch(index, key, value) {
        props.onChange(rows.map(function update(row, at) {
          return at === index ? Object.assign({}, row, { [key]: value }) : row;
        }));
      }
      function control(row, index, key, title, options) {
        const id = "dshr-action-" + index + "-" + key;
        const attrs = { id: id, className: "dshr-input", value: row[key] === undefined ? "" : row[key], disabled: props.busy,
          "data-action-field": key, "data-action-index": index,
          "aria-invalid": props.error ? "true" : undefined,
          "aria-describedby": "dshr-action-help" + (row.type === "command" ? " dshr-action-" + index + "-completion-hint" : "") + (props.error ? " dshr-host-form-error" : ""),
          onChange: function change(event) { patch(index, key, event.target.value); } };
        let input;
        if (options) input = h("select", attrs, options.map(function option(value) { return h("option", { key: value, value: value }, value); }));
        else if (key === "expect" || row.type === "wait" && key === "value") input = h("textarea", Object.assign({}, attrs, { rows: 2, required: key === "value", maxLength: 2048 }));
        else input = h("input", Object.assign({}, attrs, { type: key === "durationMs" || key === "timeoutMs" ? "number" : "text",
          required: key === "value" || key === "durationMs", min: key === "durationMs" ? 0 : key === "timeoutMs" ? 100 : undefined,
          max: key === "durationMs" || key === "timeoutMs" ? 120000 : undefined, step: key === "durationMs" || key === "timeoutMs" ? 1 : undefined,
          placeholder: key === "timeoutMs" ? "30000" : undefined,
          maxLength: key === "label" ? 80 : key === "value" ? 4096 : undefined }));
        return h("label", { className: "dshr-field", htmlFor: id, key: key }, h("span", { className: "dshr-field-label" }, title), input);
      }
      return h("section", { className: "dshr-actions-editor", "aria-label": "有序终端动作" },
        h("h3", { className: "dshr-actions-heading" }, "终端动作 · " + rows.length + "/32"),
        h("p", { id: "dshr-action-help", className: "dshr-form-note" }, "command 自动发送 Enter，默认等待新的 shell 提示符；text 不发送 Enter，key 只发送一次按键，无预期输出时发送即完成，请用后续 wait 等待交互完成。第一步可用 wait 等待非 Shell / 菜单式入口的指定文字。wait / 预期输出均为文字匹配，不是正则表达式。每步默认超时 30000 毫秒，最长 120000 毫秒；整个序列最长 20 分钟。不要在动作或标签中填写密码、令牌或私钥；SSH 认证使用密码对话框或环境变量。"),
        h("ol", { className: "dshr-action-list" }, rows.map(function renderRow(row, index) {
          function button(action, title, disabled, onClick) { return h("button", { type: "button", className: "dshr-btn", "data-action-control": action, "data-action-index": index, "aria-label": "第 " + (index + 1) + " 步" + title, disabled: props.busy || disabled, onClick: onClick }, title); }
          return h("li", { className: "dshr-action-row", key: index, "data-action-row": index },
            h("div", { className: "dshr-action-toolbar" }, h("strong", null, "第 " + (index + 1) + " 步"),
              button("up", "上移", index === 0, function up() { props.onChange(reorderActions(rows, index, -1)); }),
              button("down", "下移", index === rows.length - 1, function down() { props.onChange(reorderActions(rows, index, 1)); }),
              button("remove", "删除", rows.length === 1, function remove() { props.onChange(rows.filter(function keep(_row, at) { return at !== index; })); })),
            h("div", { className: "dshr-form-grid" },
              h("label", { className: "dshr-field", htmlFor: "dshr-action-" + index + "-type" }, h("span", { className: "dshr-field-label" }, "动作类型"),
                h("select", { id: "dshr-action-" + index + "-type", className: "dshr-input", value: row.type, disabled: props.busy, "data-action-field": "type", "data-action-index": index,
                  onChange: function typeChange(event) { props.onChange(rows.map(function change(item, at) { return at === index ? Object.assign(newAction(event.target.value), item.label ? { label: item.label } : {}) : item; })); } },
                  ACTION_TYPES.map(function typeOption(type) { return h("option", { key: type, value: type }, type); }))),
              control(row, index, "label", "标签（可选，请勿填写秘密）"),
              row.type === "delay" ? control(row, index, "durationMs", "延迟（毫秒，0–120000）") : control(row, index, "value", row.type === "wait" ? "等待文字 *" : row.type === "key" ? "按键 *" : row.type === "command" ? "命令 *" : "原始文字（不发送 Enter）*", row.type === "key" ? ACTION_KEYS : undefined),
              row.type !== "delay" ? control(row, index, "timeoutMs", "完成超时（毫秒，默认 30000）") : null,
              ["command", "text", "key"].includes(row.type) ? control(row, index, "expect", "预期输出（可选，文字匹配）") : null,
              row.type === "command" ? control(row, index, "expectCluster", "目标集群 root 提示符（可选，与预期输出互斥）") : null),
            row.type === "command" ? h("p", { id: "dshr-action-" + index + "-completion-hint", className: "dshr-form-note" }, "默认等待 Shell 提示符，不校验退出码；切换登录目标请指定目标成功输出或集群 root 提示符。") : null);
        })),
        h("button", { type: "button", className: "dshr-btn", "data-action-control": "add", disabled: props.busy || rows.length >= 32,
          title: rows.length >= 32 ? "最多 32 步" : "在末尾添加动作", onClick: function add() { if (rows.length < 32) props.onChange(rows.concat([newAction("command")])); } }, "添加动作"));
    }

    /** Empty form model for the add/edit host modal. */
    function emptyHostForm(host) {
      const source = host !== null && host !== undefined ? host : {};
      return {
        connectionMode: source.viaHost ? "cluster" : "ssh",
        viaHost: typeof source.viaHost === "string" ? source.viaHost : "",
        actions: hostActions(source),
        name: typeof source.name === "string" ? source.name : "",
        host: typeof source.host === "string" ? source.host : "",
        port: typeof source.port === "number" ? String(source.port) : "",
        username: typeof source.username === "string" ? source.username : "",
        identityFile: typeof source.identityFile === "string" ? source.identityFile : "",
        passwordEnv: typeof source.passwordEnv === "string" ? source.passwordEnv : "",
        passphraseEnv: typeof source.passphraseEnv === "string" ? source.passphraseEnv : "",
        proxyJump: Array.isArray(source.proxyJump) ? source.proxyJump.join(", ") : "",
        tags: Array.isArray(source.tags) ? source.tags.join(", ") : "",
        description: typeof source.description === "string" ? source.description : "",
      };
    }

    /** Validate the form model into a `ManagedHostInput` (throws a user-facing message). */
    function buildHostInput(form) {
      const input = { name: String(form.name || "").trim(), host: String(form.host || "").trim() };
      if (input.name.length === 0) throw new Error("请填写主机名称");
      if (form.connectionMode === "cluster") {
        const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
        const viaHost = String(form.viaHost || "").trim();
        if (!safeName.test(viaHost)) throw new Error("请选择入口主机（1-64 位字母、数字、点、下划线或短横线）");
        if (viaHost === input.name) throw new Error("入口主机不能是连接自身");
        const profile = { name: input.name, viaHost: viaHost, actions: buildActionInput(form.actions) };
        const tags = splitList(form.tags);
        if (tags.length > 0) profile.tags = tags;
        const description = String(form.description || "").trim();
        if (description.length > 0) profile.description = description;
        return profile;
      }
      if (input.host.length === 0) throw new Error("请填写主机地址");
      const portText = String(form.port || "").trim();
      if (portText.length > 0) {
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1-65535 之间的整数");
        input.port = port;
      }
      for (const key of ["username", "identityFile", "passwordEnv", "passphraseEnv"]) {
        const value = String(form[key] || "").trim();
        if (value.length > 0) input[key] = value;
      }
      const proxyJump = splitList(form.proxyJump);
      if (proxyJump.length > 0) input.proxyJump = proxyJump;
      const tags = splitList(form.tags);
      if (tags.length > 0) input.tags = tags;
      const description = String(form.description || "").trim();
      if (description.length > 0) input.description = description;
      return input;
    }

    /**
     * Add/edit host modal. `mode` is `"create"` or `"edit"`; `host` is the
     * current HostView for edit (auth fields are prefilled when the HostView
     * exposes them, so a save does not clear existing auth references).
     */
    function HostFormModal(props) {
      const mode = props.mode === "edit" ? "edit" : "create";
      const [form, setForm] = React.useState(function initial() {
        return emptyHostForm(mode === "edit" ? props.host : null);
      });
      const [localError, setLocalError] = React.useState(null);
      const error = localError !== null ? localError : props.error;

      function setField(key, value) {
        setForm(function merge(previous) {
          const next = Object.assign({}, previous);
          next[key] = value;
          return next;
        });
      }

      function submit() {
        setLocalError(null);
        let input;
        try {
          input = buildHostInput(form);
        } catch (failure) {
          setLocalError(errorText(failure));
          return;
        }
        props.onSubmit(input);
      }

      const isCluster = form.connectionMode === "cluster";
      const fieldDescriptions = isCluster ? [
        HOST_FORM_FIELDS[0],

        HOST_FORM_FIELDS[HOST_FORM_FIELDS.length - 1],
      ] : HOST_FORM_FIELDS;
      const fields = fieldDescriptions.map(function renderField(description) {
        const fieldId = "dshr-host-field-" + description.key;
        const value = form[description.key];
        return h(
          "label",
          { className: "dshr-field", key: description.key, htmlFor: fieldId },
          h(
            "span",
            { className: "dshr-field-label" },
            description.label,
            description.required === true ? h("span", { className: "dshr-field-required" }, "*") : null,
          ),
          h("input", {
            id: fieldId,
            className: "dshr-input",
            type: description.type === "number" ? "number" : "text",
            value: value,
            placeholder: description.placeholder,
            "data-host-field": description.key,
            required: description.required === true,
            disabled: props.busy === true,
            "aria-describedby": fieldId + "-hint" + (error ? " dshr-host-form-error" : ""),
            "aria-invalid": error ? "true" : undefined,
            onChange: function change(event) {
              setField(description.key, event.target.value);
            },
          }),
          description.hint ? h("span", { id: fieldId + "-hint", className: "dshr-field-hint" }, description.hint) : null,
        );
      });

      return h(
        ModalShell,
        {
          title: mode === "edit" ? "编辑主机 · " + String(props.host && props.host.name ? props.host.name : "") : "添加主机",
          wide: true,
          trapFocus: true,
          rootAttrs: { "data-dsh-remote-host-form": mode, "aria-busy": props.busy === true },
          onClose: props.onClose,
          headExtra: h("span", { className: "dshr-hint" }, "认证字段填写环境变量名称或私钥路径，绝不保存明文"),
          footer: h(
            "div",
            { className: "dshr-modal-actions" },
            h(
              "button",
              { className: "dshr-btn", type: "button", "data-host-form-action": "cancel", onClick: props.onClose },
              "取消",
            ),
            h(
              "button",
              {
                className: "dshr-btn dshr-btn-primary",
                type: "button",
                "data-host-form-action": "save",
                onClick: submit,
                disabled: props.busy === true,
              },
              props.busy === true ? "保存中…" : "保存",
            ),
          ),
        },
        h("label", { className: "dshr-field", htmlFor: "dshr-host-connection-mode" },
          h("span", { className: "dshr-field-label" }, "连接模式"),
          h("select", { id: "dshr-host-connection-mode", className: "dshr-input", value: form.connectionMode,
            disabled: props.busy === true, "data-host-field": "connectionMode",
            onChange: function changeMode(event) { setField("connectionMode", event.target.value); } },
            h("option", { value: "ssh" }, "普通 SSH"), h("option", { value: "cluster" }, "终端快捷连接（有序动作）"))),
        isCluster ? h("label", { className: "dshr-field", htmlFor: "dshr-host-field-viaHost" },
          h("span", { className: "dshr-field-label" }, "入口主机 *"),
          h("select", { id: "dshr-host-field-viaHost", className: "dshr-input", value: form.viaHost,
            required: true, disabled: props.busy === true, "data-host-field": "viaHost",
            "aria-describedby": "dshr-profile-note" + (error ? " dshr-host-form-error" : ""),
            "aria-invalid": error ? "true" : undefined,
            onChange: function changeEntry(event) { setField("viaHost", event.target.value); } },
            h("option", { value: "" }, "选择已有的普通 SSH 入口"),
            (props.hosts || []).filter(function entryHost(host) {
              return host.name !== form.name && !terminalOnlyHost(host) && host.allowed !== false;
            }).map(function entryOption(host) {
              return h("option", { key: host.name, value: host.name }, host.name + " · " + (host.target || host.host || ""));
            }),
            form.viaHost && !(props.hosts || []).some(function hasEntry(host) { return host.name === form.viaHost; })
              ? h("option", { value: form.viaHost }, form.viaHost + "（入口不可用，请重新选择）") : null)) : null,
        h("div", { className: "dshr-form-grid" }, fields),
        isCluster ? renderActionEditor({ actions: form.actions, busy: props.busy === true, error: error,
          onChange: function actionsChange(actions) { setField("actions", actions); } }) : null,
        isCluster ? h("div", { id: "dshr-profile-note", className: "dshr-form-note" },
          h("p", null, PROFILE_NOTE), h("p", null, TERMINAL_ONLY_NOTE)) : null,
        h(
          "label",
          { className: "dshr-field dshr-field-wide", htmlFor: "dshr-host-field-description" },
          h("span", { className: "dshr-field-label" }, "描述"),
          h("textarea", {
            id: "dshr-host-field-description",
            className: "dshr-input dshr-textarea",
            rows: 2,
            value: form.description,
            placeholder: "primary web node",
            "data-host-field": "description",
            onChange: function change(event) {
              setField("description", event.target.value);
            },
          }),
        ),
        mode === "edit"
          ? h(
              "p",
              { className: "dshr-form-note" },
              "编辑只会修改这里保存的托管主机；来自 ~/.ssh/config 的主机是只读的。",
            )
          : h(
              "p",
              { className: "dshr-form-note" },
              "托管主机保存在 $DSH_HOME/remote/hosts.json；~/.ssh/config 中的主机在这里只读。",
            ),
        error !== null && error !== undefined
          ? h("div", { id: "dshr-host-form-error", role: "alert", className: "dshr-form-error", "data-host-form-error": "" }, "保存失败：" + error)
          : null,
      );
    }

    /**
     * Per-host audit viewer (`audit.list {host, limit: 500, full: true}`).
     * v0.5.1: each row expands to the complete `detailFull` (whitespace
     * preserved in a <pre>) and JSON/CSV/TXT export writes the current host's
     * retained trail with full detail. Refresh/close/empty state stay.
     */
    function AuditModal(props) {
      const hostName = String(props.hostName || "");
      const [state, setState] = React.useState({ loading: true, error: null, entries: [], total: 0 });
      const [expandedId, setExpandedId] = React.useState(null);
      const [exporting, setExporting] = React.useState("");
      const [exportError, setExportError] = React.useState(null);
      const exportHostRef = React.useRef(null);

      const load = React.useCallback(
        async function load() {
          setState(function pending(previous) {
            return { loading: true, error: null, entries: previous.entries, total: previous.total };
          });
          try {
            const result = await callApi("audit.list", {
              host: hostName,
              limit: AUDIT_EXPORT_LIMIT,
              full: true,
            });
            setState({
              loading: false,
              error: null,
              entries: result !== null && result !== undefined && Array.isArray(result.entries) ? result.entries : [],
              total: result !== null && result !== undefined && typeof result.total === "number" ? result.total : 0,
            });
          } catch (failure) {
            setState({ loading: false, error: errorText(failure), entries: [], total: 0 });
          }
        },
        [hostName],
      );

      React.useEffect(function mounted() {
        load();
      }, [load]);

      function toggleExpanded(entryId) {
        setExpandedId(function flip(previous) {
          return previous === entryId ? null : entryId;
        });
      }

      async function exportEntries(format) {
        if (exporting !== "") return;
        setExporting(format);
        setExportError(null);
        try {
          // Always re-read with full detail so the download is the complete trail
          // even when the modal was opened before an operation was recorded.
          const list = await readAuditExport(hostName);
          if (!writeAuditExport(exportHostRef.current, format, list)) {
            setExportError("当前环境不支持文件下载");
          }
        } catch (failure) {
          setExportError("导出失败：" + errorText(failure));
        } finally {
          setExporting("");
        }
      }

      const entries = state.entries;
      const bodyRows = [];
      entries.forEach(function renderEntry(entry, index) {
        const entryId =
          entry !== null && entry !== undefined && typeof entry.id === "string" && entry.id.length > 0
            ? entry.id
            : "entry-" + index;
        const expanded = expandedId === entryId;
        bodyRows.push(
          h(
            "tr",
            {
              key: "entry-" + entryId,
              className: "dshr-audit-row" + (expanded ? " dshr-audit-row-open" : ""),
              "data-audit-entry": "",
              onClick: function rowClick() {
                toggleExpanded(entryId);
              },
            },
            h("td", { className: "dshr-mono" }, formatTime(entry.time)),
            h("td", { className: "dshr-mono" }, entry.tool),
            h("td", null, entry.action),
            h(
              "td",
              null,
              entry.risk
                ? h("span", { className: "dshr-badge " + riskClass(entry.risk) }, entry.risk)
                : h("span", { className: "dshr-hint" }, "—"),
            ),
            h(
              "td",
              null,
              h(
                "span",
                {
                  className: auditOutcomeClass(entry.outcome),
                  title: entry.outcome,
                },
                auditOutcomeLabel(entry.outcome),
              ),
            ),
            h(
              "td",
              { className: "dshr-mono" },
              typeof entry.durationMs === "number" ? entry.durationMs + "ms" : "—",
            ),
            h("td", { className: "dshr-detail", title: entry.detail }, entry.detail || "—"),
            h(
              "td",
              null,
              h(
                "button",
                {
                  className: "dshr-audit-expand",
                  type: "button",
                  "data-audit-expand": entryId,
                  "aria-expanded": expanded ? "true" : "false",
                  onClick: function expandClick(event) {
                    event.stopPropagation();
                    toggleExpanded(entryId);
                  },
                },
                expanded ? "收起" : "详情",
              ),
            ),
          ),
        );
        if (expanded) {
          bodyRows.push(
            h(
              "tr",
              { key: "detail-" + entryId, className: "dshr-audit-detail-row" },
              h(
                "td",
                { className: "dshr-audit-detail-cell", colSpan: 8 },
                h(
                  "pre",
                  {
                    className: "dshr-audit-full",
                    "data-audit-detail-full": "",
                    style: { whiteSpace: "pre-wrap" },
                  },
                  [auditEntryFullDetail(entry), auditRecoveryDetails(entry)].filter(Boolean).join("\n\n") || "（这条记录没有更多详情）",
                ),
              ),
            ),
          );
        }
      });
      const rows =
        entries.length === 0
          ? h(
              "p",
              { className: "dshr-empty" },
              state.loading ? "正在读取审计记录…" : "这台主机还没有记录到任何远程操作。",
            )
          : h(
              "table",
              { className: "dshr-table" },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", null, "时间"),
                  h("th", null, "工具"),
                  h("th", null, "动作"),
                  h("th", null, "风险"),
                  h("th", null, "结果"),
                  h("th", null, "耗时"),
                  h("th", null, "详情"),
                  h("th", null, "完整"),
                ),
              ),
              h("tbody", null, bodyRows),
            );

      return h(
        ModalShell,
        {
          title: "操作审计 · " + hostName,
          wide: true,
          rootAttrs: { "data-dsh-remote-audit": "host" },
          onClose: props.onClose,
          headExtra: h(
            "span",
            { className: "dshr-hint" },
            "共 " + state.total + " 条记录" + (state.loading ? " · 读取中…" : ""),
          ),
          footer: h(
            "div",
            { className: "dshr-modal-actions" },
            h(
              "button",
              { className: "dshr-btn", type: "button", "data-audit-action": "refresh", onClick: load, disabled: state.loading },
              state.loading ? "刷新中…" : "刷新",
            ),
            h(
              "button",
              {
                className: "dshr-btn",
                type: "button",
                "data-audit-action": "export-json",
                onClick: function exportJsonClick() {
                  exportEntries("json");
                },
                disabled: exporting !== "",
              },
              exporting === "json" ? "导出中…" : "导出 JSON",
            ),
            h(
              "button",
              {
                className: "dshr-btn",
                type: "button",
                "data-audit-action": "export-csv",
                onClick: function exportCsvClick() {
                  exportEntries("csv");
                },
                disabled: exporting !== "",
              },
              exporting === "csv" ? "导出中…" : "导出 CSV",
            ),
            h(
              "button",
              {
                className: "dshr-btn",
                type: "button",
                "data-audit-action": "export-txt",
                onClick: function exportTxtClick() {
                  exportEntries("txt");
                },
                disabled: exporting !== "",
              },
              exporting === "txt" ? "导出中…" : "导出 TXT",
            ),
            h(
              "button",
              { className: "dshr-btn", type: "button", "data-audit-action": "close", onClick: props.onClose },
              "关闭",
            ),
          ),
        },
        h(
          "div",
          { className: "dshr-audit-body", ref: exportHostRef },
          state.error !== null
            ? h("div", { className: "dshr-error" }, "读取审计记录失败：" + state.error)
            : null,
          exportError !== null
            ? h("div", { className: "dshr-error", "data-audit-export-error": "" }, exportError)
            : null,
          rows,
        ),
      );
    }

    /** Delete confirmation for a managed host (Escape cancels). */
    function DeleteConfirmModal(props) {
      return h(
        ModalShell,
        {
          title: "删除主机",
          rootAttrs: { "data-dsh-remote-confirm": "delete-host" },
          onClose: props.onClose,
          footer: h(
            "div",
            { className: "dshr-modal-actions" },
            h(
              "button",
              { className: "dshr-btn", type: "button", "data-confirm-action": "cancel", onClick: props.onClose },
              "取消",
            ),
            h(
              "button",
              {
                className: "dshr-btn dshr-btn-danger",
                type: "button",
                "data-confirm-action": "ok",
                onClick: props.onConfirm,
                disabled: props.busy === true,
              },
              props.busy === true ? "删除中…" : "删除",
            ),
          ),
        },
        h(
          "p",
          { className: "dshr-confirm-text" },
          "确定删除托管主机 ",
          h("span", { className: "dshr-mono" }, String(props.hostName || "")),
          " 吗？这会从 $DSH_HOME/remote/hosts.json 移除它的连接信息，不会影响远端服务器。",
        ),
      );
    }

    // BEGIN GENERATED TARGET UI
    // Standalone logical-host target-check editor. Saves configuration only.
    function buildTargetCheckInput(rows) {
      if (!Array.isArray(rows) || rows.length > 10) throw new Error("目标检查最多 10 项");
      const names = new Set();
      return rows.map((row, index) => {
        const error = (message, field) => { const failure = new Error(message); failure.field = index + "-" + field; throw failure; };
        if (!row || typeof row !== "object") error("检查格式无效", "name");
        const name = typeof row.name === "string" ? row.name.trim() : "";
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name) || names.has(name)) error("检查名称需为不重复的安全标识符（最多 80 字符）", "name");
        names.add(name);
        if (typeof row.command !== "string" || !row.command.trim() || new TextEncoder().encode(row.command).length > 4096 || /[\x00-\x1f\x7f]/.test(row.command)) error("检查命令需为非空的单行文本（最多 4 KiB，无控制字符）", "command");
        if (typeof row.expected !== "string" || !row.expected.trim() || new TextEncoder().encode(row.expected).length > 4096 || /[\x00-\x08\x0b-\x1f\x7f]/.test(row.expected)) error("精确预期值不能为空、超过 4 KiB 或包含不支持的控制字符", "expected");
        return { name, command: row.command, expected: row.expected };
      });
    }
    function TargetCheckField(props) {
      const id = "dshr-target-check-" + props.id, errorId = id + "-error";
      const attrs = { id, className: "dshr-input" + (props.multiline ? " dshr-textarea" : ""), value: props.value || "", disabled: props.busy, required: true,
        "data-target-field": props.id, "aria-invalid": props.error ? true : undefined, "aria-describedby": props.error ? errorId : undefined,
        onChange: event => props.onChange(event.target.value) };
      return h("div", { className: "dshr-field" },
        h("label", { className: "dshr-field-label", htmlFor: id }, props.label + " *"),
        props.multiline ? h("textarea", Object.assign({ rows: 2 }, attrs)) : h("input", Object.assign({ type: "text", autoComplete: "off" }, attrs)),
        props.error ? h("span", { className: "dshr-error", id: errorId }, props.error) : null);
    }
    function TargetCheckEditor(props) {
      const [state, setState] = React.useState({ loading: true, loaded: false, revision: 0, checks: [], configuredChecks: [], error: "", field: null });
      const [busy, setBusy] = React.useState(false);
      const lock = React.useRef(false), alive = React.useRef(true), sequence = React.useRef(0);
      async function load() {
        const request = ++sequence.current;
        setState(previous => Object.assign({}, previous, { loading: true, loaded: false, error: "", field: null }));
        try {
          const result = await callApi("target.get", { host: props.host.name });
          if (!result || result.host !== props.host.name || !Number.isSafeInteger(result.revision) || !Array.isArray(result.checks) || !Array.isArray(result.configuredChecks)) throw new Error("目标检查响应无效；未开放保存");
          if (alive.current && sequence.current === request) setState({ loading: false, loaded: true, revision: result.revision, checks: result.checks.map(row => Object.assign({}, row)), configuredChecks: result.configuredChecks, error: "", field: null });
        } catch (failure) { if (alive.current && sequence.current === request) setState(previous => Object.assign({}, previous, { loading: false, loaded: false, error: errorText(failure), field: null })); }
      }
      React.useEffect(() => { alive.current = true; load(); return () => { alive.current = false; sequence.current++; }; }, [props.host.name]);
      const close = () => { if (!lock.current) props.onClose(); };
      const change = rows => setState(previous => Object.assign({}, previous, { checks: rows, error: "", field: null }));
      async function save(event) {
        event.preventDefault(); if (lock.current || state.loading || !state.loaded) return;
        lock.current = true; setBusy(true); setState(previous => Object.assign({}, previous, { error: "", field: null }));
        try {
          const checks = buildTargetCheckInput(state.checks);
          const result = await callApi("target.save", { host: props.host.name, expectedRevision: state.revision, checks });
          if (alive.current) props.onSaved(result);
        } catch (failure) { if (alive.current) setState(previous => Object.assign({}, previous, { error: errorText(failure), field: failure.field || null })); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
      }
      const button = (label, action, onClick, disabled) => h("button", { type: "button", className: "dshr-btn", "data-target-action": action, disabled: busy || disabled, onClick }, label);
      return h(ModalShell, { title: "目标检查 · " + props.host.name, trapFocus: true, wide: true, onClose: close, rootAttrs: { "data-target-editor": props.host.name, "aria-busy": busy } },
        h("form", { onSubmit: save, className: "dshr-target-form", "aria-busy": busy }, h("style", null, TARGET_CHECK_CSS),
          h("p", { className: "dshr-sub" }, "只保存此逻辑主机的检查配置，不继承入口机的预期身份。保存不探测远端，也不授予执行权限；后续命令仍遵守原有审批与目标核验规则。"),
          state.error ? h("p", { role: "alert", className: "dshr-error" }, state.error) : null,
          state.loading ? h("p", { role: "status" }, "读取目标检查…") : state.loaded ? h(React.Fragment, null,
            state.configuredChecks.length ? h("section", { className: "dshr-target-section" }, h("strong", null, "配置文件检查（只读，不能在此移除）"), state.configuredChecks.map(row => h("p", { key: row.name, className: "dshr-mono dshr-target-preview" }, row.name + ": " + row.command + " → " + JSON.stringify(row.expected)))) : null,
            !state.checks.length ? h("div", { className: "dshr-target-empty" }, h("p", null, "尚未添加页面托管检查。请填写该场地真实的主机、用户或集群上下文预期值。"), button("添加目标检查", "add", () => change([{ name: "", command: "", expected: "" }]), false)) : state.checks.map((row, index) => h("fieldset", { className: "dshr-target-section", key: index }, h("legend", null, "检查 " + (index + 1)),
              ["name", "command", "expected"].map(field => h(TargetCheckField, { key: field, id: index + "-" + field, label: { name: "检查名称", command: "检查命令", expected: "精确预期值" }[field], value: row[field], multiline: field === "expected", busy,
                error: state.field === index + "-" + field ? state.error : null, onChange: value => setState(previous => Object.assign({}, previous, { error: "", field: null, checks: previous.checks.map((row, i) => i === index ? Object.assign({}, row, { [field]: value }) : row) })) })),
              button("移除此检查", "remove-" + index, () => change(state.checks.filter((_, i) => i !== index)), false))),
            state.checks.length ? button("添加检查", "add", () => change(state.checks.concat({ name: "", command: "", expected: "" })), state.checks.length >= 10) : null) : null,
          h("p", { className: "dshr-field-hint" }, "高风险或切换上下文的检查由服务端拒绝；未知命令执行时仍需独立审批。清空托管列表不移除配置文件检查。"),
          h("div", { className: "dshr-modal-actions" }, button("取消", "cancel", close, false),
            h("button", { type: "submit", className: "dshr-btn dshr-btn-primary", "data-target-action": "save", disabled: busy || state.loading || !state.loaded }, busy ? "保存中…" : "保存目标检查"),
            state.error && !state.loading ? button("重新读取", "reload", load, false) : null)));
    }
    const TARGET_CHECK_CSS = [
      ".dshr-target-form{padding:16px}.dshr-target-form>.dshr-sub{margin-bottom:12px}",
      ".dshr-target-section{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;min-width:0;padding:12px;margin:12px 0}.dshr-target-section legend{padding:0 4px;font-size:12px;font-weight:600}",
      ".dshr-target-preview{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11.5px}.dshr-target-empty{padding:12px 0;color:var(--dsw-alias-label-secondary)}",
      ".dshr-target-form input:focus-visible,.dshr-target-form textarea:focus-visible,.dshr-target-form button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}"
    ].join("\n");
    // END GENERATED TARGET UI

    function RemoteOpsPage() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [testResults, setTestResults] = React.useState({});
      const [testing, setTesting] = React.useState("");
      const [preview, setPreview] = React.useState(null);
      // v0.5 host management + quick connect state.
      const [notice, setNotice] = React.useState(null);
      const [hostForm, setHostForm] = React.useState(null);
      const [hostFormBusy, setHostFormBusy] = React.useState(false);
      const [hostFormError, setHostFormError] = React.useState(null);
      const [auditHost, setAuditHost] = React.useState(null);
      const [deleteHost, setDeleteHost] = React.useState(null);
      const [deleteBusy, setDeleteBusy] = React.useState(false);
      const [connectingHost, setConnectingHost] = React.useState("");
      const [selectedHostName, setSelectedHostName] = React.useState("");
      // v0.5.1: the Recent Operations header exports the full retained trail.
      const [auditExportOpen, setAuditExportOpen] = React.useState(false);
      const [auditExporting, setAuditExporting] = React.useState("");
      const pageRootRef = React.useRef(null);
      const hostRailRef = React.useRef(null);
      const [hostSearch, setHostSearch] = React.useState("");
      const [closeHost, setCloseHost] = React.useState(null);
      const [closeHostBusy, setCloseHostBusy] = React.useState(false);
      const [closeHostError, setCloseHostError] = React.useState(null);
      const closeHostPendingRef = React.useRef(false);
      const [targetHost, setTargetHost] = React.useState(null);

      const refresh = React.useCallback(async function refresh(showBusy) {
        if (showBusy) setBusy(true);
        try {
          const result = await callApi("overview");
          setData(result);
          setError(null);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          if (showBusy) setBusy(false);
        }
      }, []);

      React.useEffect(function mounted() {
        refresh(false);
        const timer = setInterval(function tick() {
          refresh(false);
        }, REFRESH_MS);
        return function cleanup() {
          clearInterval(timer);
        };
      }, [refresh]);

      async function testHost(name) {
        const host = ((data && data.hosts) || []).find(function lookup(candidate) { return candidate.name === name; });
        if (terminalOnlyHost(host)) {
          setNotice({ kind: "info", text: TERMINAL_ONLY_NOTE });
          return;
        }
        setTesting(name);
        try {
          const result = await callApi("host.test", { name: name });
          setTestResults(function merge(previous) {
            const next = Object.assign({}, previous);
            next[name] = result;
            return next;
          });
        } catch (failure) {
          setTestResults(function merge(previous) {
            const next = Object.assign({}, previous);
            next[name] = { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
            return next;
          });
        } finally {
          setTesting("");
        }
      }

      async function closeSession(sessionId) {
        try {
          await callApi("session.close", { sessionId: sessionId });
          await refresh(false);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }

      async function readSession(sessionId) {
        try {
          const page = await callApi("session.read", { sessionId: sessionId, count: 200 });
          setPreview(page);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }

      async function clearAudit() {
        try {
          await callApi("audit.clear");
          await refresh(false);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }

      // --- v0.5: quick connect, host management, per-host audit ------------

      /**
       * Quick connect from the hosts table (v0.5.2): 连接 opens a NEW blank
       * conversation first, then creates the relay SSH PTY for that new
       * conversation id and connects inside its default native terminal; only
       * after the bridge attached is the handoff message sent into that
       * conversation. Failures after the navigation publish the pending notice
       * and reveal the 远程终端 panel instead of silently leaving a local shell.
       */
      async function runQuickConnect(hostName, talk) {
        if (connectingHost !== "") return;
        setConnectingHost(hostName);
        setNotice(null);
        try {
          const result = await connectHostTerminal({
            name: hostName,
            sessionId: onScreenSessionId(),
            talk: talk,
            // v0.5.2: 连接 opens a NEW conversation, then connects inside its
            // default native terminal (user request 点击主机运维 → 连接后打开新会话).
            startNewSession: true,
          });
          if (result.notice !== null && result.notice !== undefined) {
            setNotice({ kind: "info", text: result.notice });
          } else {
            setNotice({
              kind: "info",
              text: talk ? "已打开终端并发送接管消息：" + hostName : "已打开终端：" + hostName,
            });
          }
          await refresh(false);
        } catch (failure) {
          setNotice(noticeForFailure("连接失败：", failure));
        } finally {
          setConnectingHost("");
        }
      }

      function openCreateForm() {
        setHostFormError(null);
        setHostForm({ mode: "create", host: null });
      }

      function openEditForm(host) {
        setHostFormError(null);
        setHostForm({ mode: "edit", host: host });
      }

      async function saveHost(input) {
        if (hostForm === null) return;
        setHostFormBusy(true);
        setHostFormError(null);
        try {
          if (hostForm.mode === "edit") {
            await callApi("host.update", { name: hostForm.host.name, host: input });
          } else {
            await callApi("host.create", { host: input });
          }
          setNotice({ kind: "info", text: "已保存托管主机：" + input.name });
          setHostForm(null);
          setSelectedHostName(input.name);
          setHostSearch("");
          await refresh(false);
        } catch (failure) {
          setHostFormError(errorText(failure));
        } finally {
          setHostFormBusy(false);
        }
      }

      async function removeManagedHost() {
        if (deleteHost === null) return;
        setDeleteBusy(true);
        try {
          await callApi("host.delete", { name: deleteHost.name });
          setNotice({ kind: "info", text: "已删除托管主机：" + deleteHost.name });
          setDeleteHost(null);
          await refresh(false);
        } catch (failure) {
          setNotice({ kind: "error", text: "删除失败：" + errorText(failure) });
        } finally {
          setDeleteBusy(false);
        }
      }

      /**
       * v0.5.1: export the whole retained audit trail (JSON/CSV/TXT) with full
       * detail. `overview.audit` only carries the newest 20 entries, so the
       * export re-reads `audit.list {limit: 500, full: true}`.
       */
      async function exportAllAudit(format) {
        if (auditExporting !== "") return;
        setAuditExporting(format);
        setAuditExportOpen(false);
        try {
          const list = await readAuditExport();
          if (writeAuditExport(pageRootRef.current, format, list)) {
            setNotice({
              kind: "info",
              text: "已导出 " + list.length + " 条操作记录（" + String(format).toUpperCase() + "）",
            });
          } else {
            setNotice({ kind: "error", text: "导出失败：当前环境不支持文件下载" });
          }
        } catch (failure) {
          setNotice({ kind: "error", text: "导出失败：" + errorText(failure) });
        } finally {
          setAuditExporting("");
        }
      }

      const hosts = (data && data.hosts) || [];
      const sessions = (data && data.sessions) || [];
      const audit = (data && data.audit) || [];
      const terminalSessions = data && data.terminal && Array.isArray(data.terminal.sessions) ? data.terminal.sessions : [];
      const searchTerms = hostSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const visibleHosts = hosts.filter(function matchesSearch(host) {
        const searchable = [host.name, host.target, host.host, host.username, host.viaHost,
          host.description, host.source].concat(host.tags || []).join(" ").toLowerCase();
        return searchTerms.every(function matchesTerm(term) { return searchable.includes(term); });
      });
      const selectedHost = visibleHosts.find(function matchHost(host) {
        return host.name === selectedHostName;
      }) || visibleHosts[0] || null;

      function openCloseHost(host) {
        setCloseHostError(null);
        setCloseHost({
          name: host.name,
          shells: sessions.filter(function hostShell(session) { return session.host === host.name; }),
          relays: hostRelaySessions(host).filter(function activeRelay(session) { return session.state !== "closed"; }),
        });
      }

      async function closeHostConnections() {
        if (closeHost === null || closeHostPendingRef.current) return;
        closeHostPendingRef.current = true;
        setCloseHostBusy(true);
        setCloseHostError(null);
        const failures = [];
        // A shared Agent PTY may close its relay too. Missing entries are benign;
        // continue closing the remaining sessions even if one close fails.
        const shellIds = new Set();
        const relayKeys = new Set();
        const requests = closeHost.shells.filter(function uniqueShell(session) {
          if (!session.sessionId || shellIds.has(session.sessionId)) return false;
          shellIds.add(session.sessionId);
          return true;
        }).map(function shellRequest(session) {
          return { method: "session.close", params: { sessionId: session.sessionId } };
        }).concat(closeHost.relays.filter(function uniqueRelay(session) {
          if (!session.sessionKey || relayKeys.has(session.sessionKey)) return false;
          relayKeys.add(session.sessionKey);
          return true;
        }).map(function relayRequest(session) {
          return { method: "terminal.close", params: { sessionKey: session.sessionKey } };
        }));
        const failedShellIds = new Set();
        const failedRelayKeys = new Set();
        try {
          for (const request of requests) {
            try {
              await callApi(request.method, request.params);
            } catch (failure) {
              if (failure.code !== "TERMINAL_NOT_FOUND" && failure.code !== "NO_SESSION") {
                failures.push(errorText(failure));
                if (request.method === "session.close") failedShellIds.add(request.params.sessionId);
                else failedRelayKeys.add(request.params.sessionKey);
              }
            }
          }
          await refresh(false);
          if (failures.length > 0) {
            setCloseHost({ name: closeHost.name,
              shells: closeHost.shells.filter(function failedShell(session) { return failedShellIds.has(session.sessionId); }),
              relays: closeHost.relays.filter(function failedRelay(session) { return failedRelayKeys.has(session.sessionKey); }),
            });
            setCloseHostError("部分连接关闭失败，请重试：" + failures.join("；"));
          } else {
            setNotice({ kind: "info", text: "已关闭主机 " + closeHost.name + " 的 SSH 会话，连接配置已保留。" });
            setCloseHost(null);
          }
        } finally {
          closeHostPendingRef.current = false;
          setCloseHostBusy(false);
        }
      }

      function handleHostNavKeyDown(event, index) {
        let nextIndex = index;
        if (event.key === "ArrowDown") nextIndex = Math.min(visibleHosts.length - 1, index + 1);
        else if (event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = visibleHosts.length - 1;
        else return;
        event.preventDefault();
        const nextHost = visibleHosts[nextIndex];
        if (nextHost === undefined) return;
        setSelectedHostName(nextHost.name);
        const buttons = hostRailRef.current && hostRailRef.current.querySelectorAll("[data-host-select]");
        if (buttons && buttons[nextIndex]) buttons[nextIndex].focus();
      }

      function hostRelaySessions(host) {
        return terminalSessions.filter(function sameHost(session) {
          return session !== null && session !== undefined && session.host === host.name;
        });
      }

      function hostTestStatus(host) {
        const relays = hostRelaySessions(host);
        if (relays.some(function connected(session) { return session.state === "connected" && terminalSessionStateLabel(session) !== "初始化未完成"; })) {
          return { text: "终端在线", className: "dshr-host-state-ok" };
        }
        if (relays.some(function unfinished(session) { return session.actionProgress && (session.actionProgress.state === "failed" || session.actionProgress.state === "cancelled"); })) {
          return { text: "终端动作已停止", className: "dshr-host-state-error" };
        }
        if (relays.some(function connecting(session) { return session.state === "connecting" || session.state === "reconnecting" || terminalSessionStateLabel(session) === "初始化未完成"; })) {
          return { text: "终端连接中", className: "dshr-host-state-wait" };
        }
        if (relays.some(function errored(session) { return session.state === "error"; })) {
          return { text: "终端异常", className: "dshr-host-state-error" };
        }
        if (testing === host.name) return { text: "测试中", className: "dshr-host-state-wait" };
        const result = testResults[host.name];
        if (result) {
          return result.ok
            ? { text: "连接正常", className: "dshr-host-state-ok" }
            : { text: "连接失败", className: "dshr-host-state-error" };
        }
        return host.allowed === false
          ? { text: "策略阻止", className: "dshr-host-state-error" }
          : { text: terminalOnlyHost(host) ? "仅终端连接" : "尚未测试", className: "dshr-host-state-idle" };
      }

      const hostNavItems = visibleHosts.map(function renderHostNav(host, index) {
        const status = hostTestStatus(host);
        const selected = selectedHost !== null && selectedHost.name === host.name;
        return h(
          "button",
          {
            key: host.name,
            type: "button",
            className: "dshr-host-option" + (selected ? " dshr-host-option-selected" : ""),
            "data-host-select": "",
            "data-host-name": host.name,
            "aria-current": selected ? "page" : undefined,
            "aria-label": host.name + "，" + (connectionProfileLabel(host) || host.target) + "，" + status.text,
            tabIndex: selected ? 0 : -1,
            title: host.name + " · " + (connectionProfileLabel(host) || host.target),
            onClick: function selectHost() { setSelectedHostName(host.name); },
            onKeyDown: function navigateHosts(event) { handleHostNavKeyDown(event, index); },
          },
          h(
            "span",
            { className: "dshr-host-option-head" },
            h("span", { className: "dshr-host-option-name" }, host.name),
            h("span", { className: "dshr-host-option-indicator " + status.className }, status.text),
          ),
          h("span", { className: "dshr-host-option-target dshr-mono" }, connectionProfileLabel(host) || host.target),
          h(
            "span",
            { className: "dshr-host-option-meta" },
            host.source + " · " + (host.readonly ? "只读主机" : host.allowed ? "允许写入" : "策略阻止"),
          ),
        );
      });
      const selectedHostStatus = selectedHost === null ? null : hostTestStatus(selectedHost);
      const selectedHostResult = selectedHost === null ? null : testResults[selectedHost.name] || null;
      const selectedHostSessions = selectedHost === null
        ? []
        : sessions.filter(function hostSession(session) { return session.host === selectedHost.name; });
      const selectedRelaySessions = selectedHost === null ? [] : hostRelaySessions(selectedHost);
      const selectedHostConnectionCount = selectedHostSessions.length +
        selectedRelaySessions.filter(function activeRelay(session) { return session.state !== "closed"; }).length;
      const selectedRelaySession = selectedRelaySessions.find(function activeRelay(session) {
        return session.state === "connected" || session.state === "connecting" || session.state === "reconnecting";
      }) || selectedRelaySessions[0] || null;

      return h(
        "div",
        { className: "dshr-page", ref: pageRootRef },
        h(
          "div",
          { className: "dshr-scroll" },
          h(
            "header",
            { className: "dshr-head" },
            h(
              "div",
              null,
              h("h1", { className: "dshr-title" }, "远程运维"),
              h(
                "p",
                { className: "dshr-sub" },
                "dsh-remote v" + ((data && data.version) || "?") + " · " +
                  hosts.length + " 台主机 · " + sessions.length + " 个会话 · " +
                  audit.length + " 条操作记录",
              ),
            ),
            h(
              "div",
              { className: "dshr-head-actions" },
              h("button", { className: "dshr-btn", onClick: function onclick() { refresh(true); }, disabled: busy }, busy ? "刷新中…" : "刷新"),
              h("button", { className: "dshr-btn", onClick: clearAudit }, "清空操作记录"),
            ),
          ),
          error !== null
            ? h("div", { className: "dshr-error" }, "请求失败：" + error)
            : null,
          h(RemoteNotice, { notice: notice, onDismiss: function dismiss() { setNotice(null); } }),
          h(React.Fragment, null,
          h(
            "div",
            { className: "dshr-chips" },
            h("span", { className: "dshr-chip" }, "审批策略：" + ((data && data.policy) || "?")),
            h("span", { className: "dshr-chip" }, "SSH 配置：" + ((data && data.sshConfigPath) || "~/.ssh/config")),
            h("span", { className: "dshr-chip" }, "只读主机：" + (((data && data.readonlyHosts) || []).join(", ") || "无")),
            h("span", { className: "dshr-chip" }, "允许主机：" + (((data && data.allowHosts) || []).join(", ") || "全部")),
          ),
          h(
            "div",
            { className: "dshr-workbench" },
            h(
              "aside",
              { className: "dshr-connections", "aria-label": "SSH 连接管理" },
              h(
                "div",
                { className: "dshr-connections-head" },
                h(
                  "div",
                  null,
                  h("h2", { className: "dshr-connections-title" }, "SSH 连接"),
                  h("span", { className: "dshr-connections-count" }, hosts.length + " 台主机"),
                ),
                h(
                  "button",
                  {
                    className: "dshr-btn dshr-btn-sm",
                    type: "button",
                    "data-host-action": "create",
                    "aria-label": "添加 SSH 主机连接",
                    onClick: openCreateForm,
                  },
                  "+ 添加",
                ),
              ),
              h("div", { className: "dshr-connections-search" },
                h("input", {
                  className: "dshr-input", type: "search", value: hostSearch,
                  "data-host-search": "", "aria-label": "搜索 SSH 连接",
                  "aria-controls": "dshr-host-nav", "aria-describedby": "dshr-host-search-count",
                  placeholder: "搜索名称、地址、标签…",
                  onChange: function searchHosts(event) { setHostSearch(event.target.value); },
                  onKeyDown: function searchKey(event) { if (event.key === "Escape") setHostSearch(""); },
                }),
                h("span", { id: "dshr-host-search-count", className: "dshr-connections-count", role: "status", "aria-live": "polite" },
                  searchTerms.length > 0 ? "找到 " + visibleHosts.length + " / " + hosts.length + " 台主机" : "共 " + hosts.length + " 台主机"),
              ),
              visibleHosts.length === 0
                ? h(
                    "div",
                    { className: "dshr-connections-empty", role: "status", id: "dshr-host-nav" },
                    h("strong", null, data === null ? "正在读取连接…" : hosts.length === 0 ? "还没有 SSH 连接" : "没有匹配的连接"),
                    h("span", null, hosts.length === 0 ? "配置 ~/.ssh/config，或添加一台托管主机。" : "试试其他名称、地址或标签。"),
                    hostSearch ? h("button", { className: "dshr-btn", type: "button", "data-host-search-clear": "", onClick: function clearSearch() { setHostSearch(""); } }, "清空搜索") : null,
                  )
                : h(
                    "nav",
                    {
                      className: "dshr-host-nav",
                      id: "dshr-host-nav",
                      ref: hostRailRef,
                      "aria-label": "SSH 主机连接",
                    },
                    hostNavItems,
                  ),
              h(
                "p",
                { className: "dshr-connections-footnote" },
                "来源包括 ~/.ssh/config、插件配置与托管连接。",
              ),
            ),
            h(
              "section",
              { className: "dshr-host-workspace", "aria-label": "主机运维工作区" },
              selectedHost === null
                ? h(
                    "div",
                    { className: "dshr-host-empty", role: "status" },
                    h("span", { className: "dshr-host-empty-mark", "aria-hidden": "true" }, ">_"),
                    h("h2", null, data === null ? "正在加载连接" : hosts.length > 0 ? "没有匹配的 SSH 连接" : "选择一台主机开始运维"),
                    h(
                      "p",
                      null,
                      data === null
                        ? "正在从 Harness 读取 SSH 连接配置。"
                        : hosts.length > 0 ? "修改或清空左侧搜索条件后，再选择主机。" : "连接列表为空时，可以从左侧添加托管主机，或先配置 ~/.ssh/config。",
                    ),
                    hosts.length === 0
                      ? h(
                          "button",
                          {
                            className: "dshr-btn dshr-btn-primary",
                            type: "button",
                            "data-host-action": "create",
                            onClick: openCreateForm,
                          },
                          "添加主机",
                        )
                      : null,
                  )
                : h(
                    "section",
                    { className: "dshr-host-detail", "aria-labelledby": "dshr-selected-host-title" },
                    h(
                      "header",
                      { className: "dshr-host-detail-head" },
                      h(
                        "div",
                        { className: "dshr-host-identity" },
                        h("span", { className: "dshr-host-eyebrow" }, "当前连接"),
                        h("h2", { className: "dshr-host-title", id: "dshr-selected-host-title" }, selectedHost.name),
                        h("p", { className: "dshr-host-target dshr-mono" }, selectedHost.target),
                        selectedHost.viaHost ? h("p", { className: "dshr-host-target dshr-mono", "data-connection-profile": "" }, connectionProfileLabel(selectedHost)) : null,
                      ),
                      h(
                        "div",
                        { className: "dshr-host-actions" },
                        h(
                          "button",
                          {
                            className: "dshr-btn dshr-btn-primary",
                            type: "button",
                            "data-host-action": "connect",
                            "data-host-name": selectedHost.name,
                            "aria-label": "连接 " + selectedHost.name + " 并开始远程运维",
                            onClick: function connectSelected() { runQuickConnect(selectedHost.name, true); },
                            disabled: connectingHost !== "" || closeHostBusy || selectedHost.allowed === false,
                            title: selectedHost.allowed === false ? "被 allowHosts 阻止" : "打开 DSH 原生终端并交给 Agent",
                          },
                          connectingHost === selectedHost.name ? "连接中…" : "连接并开始运维",
                        ),
                        selectedHostConnectionCount > 0 ? h("button", {
                          className: "dshr-btn dshr-btn-danger", type: "button",
                          "data-host-action": "close", "data-host-name": selectedHost.name,
                          "aria-label": "关闭 " + selectedHost.name + " 的 SSH 会话",
                          title: "结束该主机在所有对话中的已建立会话，保留连接配置",
                          disabled: closeHostBusy || connectingHost !== "",
                          onClick: function closeSelectedHost() { openCloseHost(selectedHost); },
                        }, closeHostBusy && closeHost && closeHost.name === selectedHost.name ? "关闭中…" : "关闭连接") : null,
                        h(
                          "button",
                          {
                            className: "dshr-btn",
                            type: "button",
                            "data-host-action": "test",
                            "data-host-name": selectedHost.name,
                            onClick: function testSelected() { testHost(selectedHost.name); },
                            disabled: testing === selectedHost.name || terminalOnlyHost(selectedHost),
                            title: terminalOnlyHost(selectedHost) ? TERMINAL_ONLY_NOTE : "执行只读 SSH exec 探测",
                            "aria-describedby": terminalOnlyHost(selectedHost) ? "dshr-terminal-only-note" : undefined,
                          },
                          testing === selectedHost.name ? "测试中…" : "测试连接",
                        ),
                        h("button", {
                          className: "dshr-btn", type: "button",
                          "data-host-action": "target-checks", "data-host-name": selectedHost.name,
                          disabled: closeHostBusy || connectingHost !== "" || selectedHost.allowed === false,
                          onClick: function editTargetChecks() { setTargetHost(selectedHost); },
                        }, "目标检查"),
                        h(
                          "button",
                          {
                            className: "dshr-btn",
                            type: "button",
                            "data-host-action": "audit",
                            "data-host-name": selectedHost.name,
                            onClick: function auditSelected() { setAuditHost(selectedHost); },
                          },
                          "审计",
                        ),
                        selectedHost.managed === true
                          ? h(
                              "button",
                              {
                                className: "dshr-btn",
                                type: "button",
                                "data-host-action": "edit",
                                "data-host-name": selectedHost.name,
                                onClick: function editSelected() { openEditForm(selectedHost); },
                              },
                              "编辑",
                            )
                          : null,
                        selectedHost.managed === true
                          ? h(
                              "button",
                              {
                                className: "dshr-btn dshr-btn-danger",
                                type: "button",
                                "data-host-action": "delete",
                                "data-host-name": selectedHost.name,
                                onClick: function deleteSelected() { setDeleteHost(selectedHost); },
                              },
                              "删除",
                            )
                          : null,
                      ),
                    ),
                    h(
                      "div",
                      { className: "dshr-host-status-line", role: "status", "aria-live": "polite" },
                      h("span", { className: "dshr-host-state-indicator " + selectedHostStatus.className }, selectedHostStatus.text),
                      selectedHost.allowed === false
                        ? h("span", { className: "dshr-host-status-copy" }, "该主机不在 allowHosts 允许范围内，不能连接。")
                        : selectedRelaySession !== null
                          ? h(
                              "span",
                              { className: "dshr-host-status-copy" },
                              "共享终端：" + terminalSessionStateLabel(selectedRelaySession) +
                                " · 接入 " + (typeof selectedRelaySession.attached === "number" ? selectedRelaySession.attached : 0),
                            )
                          : selectedHostResult
                            ? h(
                                "span",
                                { className: "dshr-host-status-copy" },
                                selectedHostResult.ok
                                  ? "只读连通性探测完成" + (typeof selectedHostResult.latencyMs === "number" ? " · " + selectedHostResult.latencyMs + "ms" : "") + (selectedHostResult.output ? " · " + selectedHostResult.output : "")
                                  : selectedHostResult.error || "探测失败，请检查 SSH 配置和网络。",
                              )
                            : h("span", { className: "dshr-host-status-copy" }, terminalOnlyHost(selectedHost)
                                ? "该连接仅支持交互式终端，无法执行 SSH exec 连通性探测。"
                                : "测试连接只执行只读探测，不会在远端修改数据。"),
                    ),
                    selectedRelaySession && actionProgressText(selectedRelaySession.actionProgress) ? h("p", { className: "dshr-form-note", role: "status", "aria-live": "polite", "data-host-action-progress": selectedRelaySession.actionProgress.state }, actionProgressText(selectedRelaySession.actionProgress)) : null,
                    terminalOnlyHost(selectedHost) ? h("p", { id: "dshr-terminal-only-note", className: "dshr-form-note" }, TERMINAL_ONLY_NOTE) : null,
                    h(
                      "div",
                      { className: "dshr-host-facts" },
                      h("div", { className: "dshr-host-fact" }, h("span", null, "连接来源"), h("strong", null, selectedHost.source || "—")),
                      h("div", { className: "dshr-host-fact" }, h("span", null, "认证方式"), h("strong", null, selectedHost.authHint || "—")),
                      h(
                        "div",
                        { className: "dshr-host-fact" },
                        h("span", null, "操作策略"),
                        h(
                          "strong",
                          null,
                          selectedHost.allowed === false
                            ? "不在允许列表"
                            : selectedHost.readonly
                              ? "只读主机"
                              : "可执行受审批保护的操作",
                        ),
                      ),
                      h(
                        "div",
                        { className: "dshr-host-fact" },
                        h("span", null, "共享终端"),
                        h(
                          "strong",
                          null,
                          selectedRelaySession === null
                            ? "未建立"
                            : terminalSessionStateLabel(selectedRelaySession) + " · 接入 " + (typeof selectedRelaySession.attached === "number" ? selectedRelaySession.attached : 0),
                        ),
                      ),
                      h("div", { className: "dshr-host-fact" }, h("span", null, "Agent 会话"), h("strong", null, selectedHostSessions.length === 0 ? "暂无活动会话" : selectedHostSessions.length + " 个活动会话")),
                    ),
                    selectedHost.description || (selectedHost.tags && selectedHost.tags.length > 0)
                      ? h(
                          "div",
                          { className: "dshr-host-description" },
                          selectedHost.description ? h("p", null, selectedHost.description) : null,
                          selectedHost.tags && selectedHost.tags.length > 0
                            ? h("div", { className: "dshr-tags" }, selectedHost.tags.map(function renderTag(tag) { return h("span", { className: "dshr-tag", key: tag }, tag); }))
                            : null,
                        )
                      : null,
                    h(
                      "div",
                      { className: "dshr-host-terminal-note" },
                      h("strong", null, "Agent 与终端共享会话"),
                      h(
                        "p",
                        null,
                        "启用原生远程终端后，连接会在新 DSH 对话中打开 SSH 终端并交给 Agent；Agent 的 remote_shell_* 会复用同一 PTY。右侧「远程终端」持续显示 Agent 命令；你也可以直接输入或按 Ctrl-C 接手，后续 Agent 操作继续使用该 PTY。",
                        selectedHost.viaHost ? " " + PROFILE_NOTE : "",
                      ),
                    ),
                  ),
            ),
          ),
          h(
            Card,
            { title: "远程终端会话 (" + sessions.length + ")" },
            sessions.length === 0
              ? h("p", { className: "dshr-empty" }, "当前没有远程 shell 会话。让助手打开一个会话后，这里会显示会话以及可读的输出。")
              : h(
                  "table",
                  { className: "dshr-table" },
                  h("thead", null, h("tr", null, h("th", null, "会话"), h("th", null, "主机"), h("th", null, "状态"), h("th", null, "操作"))),
                  h(
                    "tbody",
                    null,
                    sessions.map(function renderSession(session) {
                      return h(
                        "tr",
                        { key: session.sessionId },
                        h("td", { className: "dshr-mono" }, session.sessionId + (session.name ? " (" + session.name + ")" : "")),
                        h("td", null, session.host),
                        h("td", null, statusLabel(session.status)),
                        h(
                          "td",
                          { className: "dshr-actions" },
                          h("button", { className: "dshr-btn dshr-btn-sm", onClick: function readClick() { readSession(session.sessionId); } }, "查看输出"),
                          h("button", { className: "dshr-btn dshr-btn-sm dshr-btn-danger", onClick: function closeClick() { closeSession(session.sessionId); } }, "结束会话"),
                        ),
                      );
                    }),
                  ),
                ),
            preview !== null
              ? h(
                  "div",
                  { className: "dshr-preview" },
                  h(
                    "div",
                    { className: "dshr-preview-head" },
                    h("span", null, "输出预览 · " + preview.sessionId + " · 共 " + preview.totalLines + " 行"),
                    h("button", { className: "dshr-btn dshr-btn-sm", onClick: function closePreview() { setPreview(null); } }, "关闭预览"),
                  ),
                  h("pre", { className: "dshr-pre" }, preview.text || "(暂无输出)"),
                )
              : null,
          ),
          h(
            Card,
            {
              title: RECENT_AUDIT_LABEL,
              extra: h(
                "div",
                { className: "dshr-card-tools" },
                h("span", { className: "dshr-hint" }, "审计记录保存在 $DSH_HOME/remote/audit.jsonl · 仅显示最新 20 条"),
                h(
                  "button",
                  {
                    className: "dshr-btn dshr-btn-sm",
                    type: "button",
                    "data-audit-action": "export-all",
                    "aria-haspopup": "menu",
                    "aria-expanded": auditExportOpen ? "true" : "false",
                    onClick: function toggleAuditExportMenu(event) {
                      event.stopPropagation();
                      setAuditExportOpen(function flip(previous) {
                        return !previous;
                      });
                    },
                    disabled: auditExporting !== "",
                  },
                  auditExporting !== "" ? "导出中…" : "导出",
                ),
                auditExportOpen
                  ? h(
                      "div",
                      { className: "dshr-menu", role: "menu", "data-audit-export-menu": "" },
                      h(
                        "button",
                        {
                          className: "dshr-menu-item",
                          type: "button",
                          role: "menuitem",
                          "data-audit-action": "export-all-json",
                          onClick: function exportAllJson() { exportAllAudit("json"); },
                        },
                        "导出全部 JSON",
                      ),
                      h(
                        "button",
                        {
                          className: "dshr-menu-item",
                          type: "button",
                          role: "menuitem",
                          "data-audit-action": "export-all-csv",
                          onClick: function exportAllCsv() { exportAllAudit("csv"); },
                        },
                        "导出全部 CSV",
                      ),
                      h(
                        "button",
                        {
                          className: "dshr-menu-item",
                          type: "button",
                          role: "menuitem",
                          "data-audit-action": "export-all-txt",
                          onClick: function exportAllTxt() { exportAllAudit("txt"); },
                        },
                        "导出全部 TXT",
                      ),
                    )
                  : null,
              ),
            },
            auditHealthNotice(data && data.auditHealth),
            audit.length === 0
              ? h("p", { className: "dshr-empty" }, "还没有远程操作记录。")
              : h(
                  "table",
                  { className: "dshr-table" },
                  h(
                    "thead",
                    null,
                    h("tr", null, h("th", null, "时间"), h("th", null, "工具"), h("th", null, "主机"), h("th", null, "动作"), h("th", null, "风险"), h("th", null, "结果"), h("th", null, "耗时"), h("th", null, "详情")),
                  ),
                  h(
                    "tbody",
                    null,
                    audit.map(function renderEntry(entry) {
                      return h(
                        "tr",
                        { key: entry.id },
                        h("td", { className: "dshr-mono" }, formatTime(entry.time)),
                        h("td", { className: "dshr-mono" }, entry.tool),
                        h("td", null, entry.host),
                        h("td", null, entry.action),
                        h(
                          "td",
                          null,
                          entry.risk
                            ? h("span", { className: "dshr-badge " + riskClass(entry.risk) }, entry.risk)
                            : h("span", { className: "dshr-hint" }, "—"),
                        ),
                        h(
                          "td",
                          null,
                          h(
                            "span",
                            {
                              className: auditOutcomeClass(entry.outcome),
                              title: entry.outcome,
                            },
                            auditOutcomeLabel(entry.outcome),
                          ),
                        ),
                        h("td", { className: "dshr-mono" }, entry.durationMs + "ms"),
                        h("td", { className: "dshr-detail", title: entry.detail }, entry.detail),
                      );
                    }),
                  ),
                ),
          )),
          // v0.5 overlays live inside this page component (no global DOM).
          targetHost !== null ? h(TargetCheckEditor, {
            key: "target:" + targetHost.name, host: targetHost,
            onClose: function closeTargetEditor() { setTargetHost(null); },
            onSaved: function savedTargetChecks() {
              setTargetHost(null);
              setNotice({ kind: "info", text: "目标检查配置已保存，未执行任何远程探测。" });
              refresh(false);
            },
          }) : null,
          auditHost !== null
            ? h(AuditModal, {
                key: "audit:" + auditHost.name,
                hostName: auditHost.name,
                onClose: function closeAudit() { setAuditHost(null); },
              })
            : null,
          hostForm !== null
            ? h(HostFormModal, {
                key: "form:" + hostForm.mode + ":" + (hostForm.host !== null ? hostForm.host.name : ""),
                mode: hostForm.mode,
                host: hostForm.host,
                hosts: hosts,
                busy: hostFormBusy,
                error: hostFormError,
                onClose: function closeForm() {
                  if (hostFormBusy) return;
                  setHostForm(null);
                  setHostFormError(null);
                },
                onSubmit: saveHost,
              })
            : null,
          closeHost !== null ? h(ModalShell, {
            title: "关闭 SSH 连接", trapFocus: true,
            rootAttrs: { "data-dsh-remote-confirm": "close-host" },
            onClose: function cancelCloseHost() { if (!closeHostBusy) setCloseHost(null); },
            footer: h("div", { className: "dshr-modal-actions" },
              h("button", { className: "dshr-btn", type: "button", "data-confirm-action": "cancel", disabled: closeHostBusy,
                onClick: function cancelClose() { if (!closeHostBusy) setCloseHost(null); } }, "取消"),
              h("button", { className: "dshr-btn dshr-btn-danger", type: "button", "data-confirm-action": "ok", disabled: closeHostBusy,
                onClick: closeHostConnections }, closeHostBusy ? "关闭中…" : "确认关闭"),
            ),
          },
            h("p", { className: "dshr-confirm-text" }, "确定关闭主机 " + closeHost.name + " 的 SSH 会话吗？这会结束该主机在所有对话中当前列出的终端和 Agent Shell（包括共享终端的所有接入），正在这些会话中运行的任务可能被中断。连接配置会保留，之后可以重新连接。"),
            h("p", { className: "dshr-form-note" }, "不会停止独立执行的 SSH exec / SFTP 操作，也不会阻止其他对话之后重新连接。"),
            closeHostError ? h("div", { className: "dshr-form-error", role: "alert" }, closeHostError) : null,
          ) : null,
          deleteHost !== null
            ? h(DeleteConfirmModal, {
                key: "delete:" + deleteHost.name,
                hostName: deleteHost.name,
                busy: deleteBusy,
                onClose: function closeDelete() { if (!deleteBusy) setDeleteHost(null); },
                onConfirm: removeManagedHost,
              })
            : null,
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Remote Terminal right-sidebar panel (v0.4)
    // ---------------------------------------------------------------------

    /** One command renders as a prompt line, its streamed output, and a status line. */
    function renderLiveCommand(command) {
      const output =
        command.output.length > 0
          ? h("div", { className: "dslt-output" }, command.output)
          : null;
      return h(
        "section",
        {
          className: "dslt-cmd dslt-cmd-" + command.status,
          key: command.id,
          "data-live-command-id": command.id,
          "data-live-command-status": command.status,
        },
        h(
          "div",
          { className: "dslt-prompt" },
          h("span", { className: "dslt-dollar" }, "$"),
          h("span", { className: "dslt-command" }, command.command === "" ? "(empty)" : command.command),
          h("span", { className: "dslt-meta" }, "[" + command.host + "]"),
          h("span", { className: "dslt-meta dslt-meta-session" }, "[" + sessionShort(command.sessionId) + "]"),
          command.tool ? h("span", { className: "dslt-tool" }, command.tool) : null,
        ),
        output,
        h(
          "div",
          { className: "dslt-status dslt-status-" + command.status },
          liveStatusLine(command),
        ),
      );
    }

    function RemoteTerminalPanel(props) {
      const tabSessionId =
        props !== null && props !== undefined && typeof props.sessionId === "string"
          ? props.sessionId
          : null;
      const [flags, setFlags] = React.useState(null);
      const [hostFilter, setHostFilter] = React.useState("");
      const [, setVersion] = React.useState(0);
      const [atBottom, setAtBottom] = React.useState(true);
      // v0.5 launcher state: overview hosts, relay sessions, chosen target host.
      const [overview, setOverview] = React.useState(null);
      const [overviewError, setOverviewError] = React.useState(null);
      const [pickedHost, setPickedHost] = React.useState("");
      const [panelNotice, setPanelNotice] = React.useState(null);
      // v0.5.2: a failure that happened after navigation is published at module
      // level; this panel reveals it (message + command <pre> + 复制命令).
      const [pendingConnectNoticeState, setPendingConnectNoticeState] = React.useState(
        function initialPendingConnectNotice() {
          return readPendingConnectNotice();
        },
      );
      const [connecting, setConnecting] = React.useState(false);
      const logRef = React.useRef(null);
      const stickRef = React.useRef(true);
      const feed = liveFeed;
      const snapshot = feed.getSnapshot();

      const refreshOverview = React.useCallback(async function refreshOverview() {
        try {
          const result = await callApi("overview");
          setOverview(result);
          setOverviewError(null);
        } catch (failure) {
          setOverviewError(errorText(failure));
        }
      }, []);

      React.useEffect(function pollOverview() {
        let alive = true;
        refreshOverview();
        const timer = setInterval(function tick() {
          if (alive) refreshOverview();
        }, REFRESH_MS);
        return function cleanup() {
          alive = false;
          clearInterval(timer);
        };
      }, [refreshOverview]);

      React.useEffect(function mounted() {
        let alive = true;
        loadLiveFlags().then(function flagsLoaded(value) {
          if (!alive) return;
          setFlags(value);
          if (value.enabled) feed.ensureStarted();
        });
        const unsubscribe = feed.subscribe(function changed() {
          if (alive) setVersion(function bump(value) { return value + 1; });
        });
        return function cleanup() {
          alive = false;
          unsubscribe();
        };
      }, [feed]);

      React.useEffect(function bindPendingConnectNotice() {
        setPendingConnectNoticeState(readPendingConnectNotice());
        return subscribePendingConnectNotice(function changed(notice) {
          setPendingConnectNoticeState(notice);
        });
      }, []);

      const sessionCommands = snapshot.commands.filter(function sessionMatch(command) {
        if (tabSessionId === null) return true;
        // Commands without a session are shown in every panel: the Host could not
        // attribute them, and hiding them would lose the only live trace.
        return command.sessionId === null || command.sessionId === tabSessionId;
      });
      const hostOptions = [];
      for (const command of sessionCommands) {
        if (hostOptions.indexOf(command.host) === -1) hostOptions.push(command.host);
      }
      hostOptions.sort();
      if (hostFilter !== "" && hostOptions.indexOf(hostFilter) === -1) hostOptions.unshift(hostFilter);
      const visible = sessionCommands.filter(function hostMatch(command) {
        return hostFilter === "" || command.host === hostFilter;
      });

      const stickToBottom = React.useCallback(function stickToBottom() {
        stickRef.current = true;
        setAtBottom(true);
        const element = logRef.current;
        if (element !== null) element.scrollTop = element.scrollHeight;
      }, []);

      React.useLayoutEffect(function autoscroll() {
        const element = logRef.current;
        if (element === null) return;
        if (stickRef.current) element.scrollTop = element.scrollHeight;
      }, [snapshot.version, hostFilter]);

      function onScroll() {
        const element = logRef.current;
        if (element === null) return;
        const bottom =
          element.scrollHeight - element.scrollTop - element.clientHeight <= LIVE_SCROLL_SLACK;
        stickRef.current = bottom;
        setAtBottom(bottom);
      }

      function clearLocal() {
        feed.clearLocal();
        stickToBottom();
      }

      // --- v0.5 launcher: host picker, open/talk, relay session list --------

      const overviewHosts =
        overview !== null && overview !== undefined && Array.isArray(overview.hosts) ? overview.hosts : [];
      const terminalInfo =
        overview !== null && overview !== undefined && overview.terminal !== null && overview.terminal !== undefined
          ? overview.terminal
          : null;
      const terminalAvailable = terminalInfo === null || terminalInfo.available !== false;
      const terminalEnabled = !(terminalInfo !== null && terminalInfo.enabled === false);
      const defaultHost =
        overviewHosts.find(function usable(host) {
          return host !== null && host !== undefined && host.allowed !== false;
        }) || overviewHosts[0];
      const effectiveHost =
        pickedHost !== ""
          ? pickedHost
          : defaultHost !== null && defaultHost !== undefined && typeof defaultHost.name === "string"
            ? defaultHost.name
            : "";
      const effectiveHostView = overviewHosts.find(function selected(host) { return host.name === effectiveHost; });
      const relaySessions =
        terminalInfo !== null && Array.isArray(terminalInfo.sessions)
          ? terminalInfo.sessions.filter(function sameSession(session) {
              if (session === null || session === undefined) return false;
              if (tabSessionId === null) return true;
              return session.sessionId === tabSessionId;
            })
          : [];

      /** The session this panel acts on: its own tab session, else the on-screen one. */
      function panelSessionId() {
        if (tabSessionId !== null) return tabSessionId;
        return onScreenSessionId();
      }

      async function openOrTalk(talk) {
        if (connecting) return;
        if (effectiveHost === "") {
          setPanelNotice({ kind: "error", text: "请先在主机下拉框里选择一台主机" });
          return;
        }
        const sessionId = panelSessionId();
        if (sessionId === null) {
          setPanelNotice({ kind: "error", text: "当前没有可用的对话会话，无法打开原生终端" });
          return;
        }
        setConnecting(true);
        setPanelNotice(null);
        try {
          const result = await connectHostTerminal({
            name: effectiveHost,
            sessionId: sessionId,
            talk: talk,
            // v0.5.2: 连接并对话 opens a NEW conversation and connects inside its
            // default terminal; 打开终端 keeps the current conversation.
            startNewSession: talk,
          });
          setPanelNotice(
            result.notice !== null && result.notice !== undefined
              ? { kind: "info", text: result.notice }
              : { kind: "info", text: talk ? "已打开终端并发送接管消息：" + effectiveHost : "已打开终端：" + effectiveHost },
          );
          await refreshOverview();
        } catch (failure) {
          setPanelNotice(noticeForFailure("连接失败：", failure));
        } finally {
          setConnecting(false);
        }
      }

      /**
       * v0.5.2 manual fallback: call `terminal.open` for the selected host and
       * copy its shell command, so any terminal can establish the relay
       * connection by hand when the native-terminal integration is broken.
       */
      async function copyConnectCommand(event) {
        const anchor = event !== null && event !== undefined ? event.currentTarget : null;
        if (connecting) return;
        if (effectiveHost === "") {
          setPanelNotice({ kind: "error", text: "请先在主机下拉框里选择一台主机" });
          return;
        }
        const sessionId = panelSessionId();
        setConnecting(true);
        setPanelNotice(null);
        try {
          const opened = await callApi(
            "terminal.open",
            sessionId === null ? { name: effectiveHost } : { name: effectiveHost, sessionId: sessionId },
          );
          traceTerminal("api", sessionId, "terminal.open（复制连接命令）成功 host=" + effectiveHost);
          const shell = opened !== null && opened !== undefined ? opened.shell : null;
          const command =
            shell !== null && shell !== undefined && typeof shell.command === "string" ? shell.command : "";
          if (command.length === 0) {
            traceTerminal("error", sessionId, "terminal.open 没有返回终端启动命令（复制连接命令）");
            throw new Error("后端没有返回终端启动命令");
          }
          const copied = await copyTextToClipboard(command, anchor);
          if (copied) {
            setPanelNotice({ kind: "info", text: "已复制连接命令，可粘贴到任意终端执行" +
              (effectiveHostView && effectiveHostView.viaHost ? "。" + connectionProfileLabel(effectiveHostView) + "。" + PROFILE_NOTE : "") });
          } else {
            setPanelNotice({
              kind: "error",
              text: "复制失败：请手动复制下面的命令到任意终端执行",
              command: command,
              hint: "日志：" + BRIDGE_LOG_HINT,
            });
          }
          await refreshOverview();
        } catch (failure) {
          setPanelNotice(noticeForFailure("复制连接命令失败：", failure));
        } finally {
          setConnecting(false);
        }
      }

      async function attachRelaySession(session) {
        if (connecting) return;
        const sessionId =
          tabSessionId !== null
            ? tabSessionId
            : typeof session.sessionId === "string" && session.sessionId.length > 0
              ? session.sessionId
              : onScreenSessionId();
        if (sessionId === null) {
          setPanelNotice({ kind: "error", text: "当前没有可用的对话会话，无法重新接入终端" });
          return;
        }
        setConnecting(true);
        setPanelNotice(null);
        let opened = null;
        try {
          opened = await callApi("terminal.open", { name: session.host, sessionId: sessionId });
        } catch (failure) {
          if (!failure.browserOnly) traceTerminal("error", sessionId, "重新接入时 terminal.open 失败：" + errorText(failure));
          setPanelNotice(noticeForFailure("接入失败：", failure));
          setConnecting(false);
          return;
        }
        try {
          traceTerminal("api", sessionId, "terminal.open（复用）成功 host=" + session.host);
          const shell = opened !== null && opened !== undefined ? opened.shell : null;
          if (shell === null || shell === undefined || typeof shell.command !== "string" || shell.command.length === 0) {
            traceTerminal("error", sessionId, "terminal.open 没有返回终端启动命令");
            throw new Error("后端没有返回终端启动命令");
          }
          await openNativeTerminal(sessionId, shell.command, {
            sessionKey: shell.sessionKey,
            shell: shell,
            session: opened.session,
          });
          setPanelNotice({ kind: "info", text: "已重新接入终端会话：" + session.host });
          await refreshOverview();
        } catch (failure) {
          setPanelNotice(noticeForFailure("接入失败：", failure));
        } finally {
          setConnecting(false);
        }
      }

      async function closeRelaySession(session) {
        try {
          await callApi("terminal.close", { sessionKey: session.sessionKey });
          setPanelNotice({ kind: "info", text: "已关闭终端会话：" + session.host });
          await refreshOverview();
        } catch (failure) {
          setPanelNotice({ kind: "error", text: "关闭失败：" + errorText(failure) });
        }
      }

      // v0.5.2: inline panel notice wins; otherwise show a post-navigation
      // failure published by the connect flow (command <pre> + 复制命令).
      const activeNotice = panelNotice !== null ? panelNotice : pendingConnectNoticeState;
      function dismissActiveNotice() {
        setPanelNotice(null);
        clearPendingConnectNotice();
      }

      const liveEnabled = flags === null || flags.enabled !== false;
      const connection = liveEnabled ? snapshot.connection : "closed";
      const connectionLabel = liveConnectionLabel(snapshot.connection, flags);
      const empty =
        flags !== null && flags.enabled === false
          ? h(
              "div",
              { className: "dslt-empty" },
              h("p", null, "实时终端未启用。"),
              h("p", { className: "dslt-empty-hint" }, "插件配置 liveTerminal 为 false 时，远端命令不会流入此面板。"),
            )
          : h(
              "div",
              { className: "dslt-empty" },
              h(
                "p",
                null,
                hostFilter === "" ? "等待 agent 执行远端命令…" : "当前主机筛选下没有命令。",
              ),
              h(
                "p",
                { className: "dslt-empty-hint" },
                "命令会实时显示在这里。也可以在右侧面板首页点击「" + LIVE_TITLE + "」打开此面板。",
              ),
            );

      return h(
        "div",
        {
          className: "dslt-panel",
          "data-dsh-remote-live": "terminal",
          "data-live-connection": connectionLabel,
        },
        h(
          "header",
          { className: "dslt-head" },
          h(
            "div",
            { className: "dslt-head-main" },
            h("span", { className: "dslt-title" }, LIVE_TITLE),
            h(
              "span",
              {
                className: "dslt-conn dslt-conn-" + (connection === "connected" ? "on" : connection === "reconnecting" ? "wait" : "off"),
                "data-live-conn": connectionLabel,
              },
              connectionLabel,
            ),
            tabSessionId !== null
              ? h("span", { className: "dslt-session", title: tabSessionId }, "会话 " + sessionShort(tabSessionId))
              : h("span", { className: "dslt-session" }, "全部会话"),
          ),
          h(
            "div",
            { className: "dslt-head-actions" },
            h(
              "label",
              { className: "dslt-filter" },
              h("span", { className: "dslt-filter-label" }, "主机"),
              h(
                "select",
                {
                  className: "dslt-select",
                  value: hostFilter,
                  onChange: function change(event) {
                    setHostFilter(event.target.value);
                    stickRef.current = true;
                  },
                  "aria-label": "按主机筛选",
                },
                h("option", { value: "" }, "全部主机 (" + hostOptions.length + ")"),
                hostOptions.map(function option(host) {
                  return h("option", { value: host, key: host }, host);
                }),
              ),
            ),
            liveEnabled && connection === "closed"
              ? h(
                  "button",
                  { className: "dslt-btn", type: "button", onClick: function reconnect() { feed.reconnect(); } },
                  "重连接",
                )
              : null,
            h(
              "button",
              { className: "dslt-btn", type: "button", onClick: clearLocal, title: "仅清空本地显示，不影响 agent" },
              "清空",
            ),
            h("span", { className: "dslt-count" }, visible.length + " 条命令"),
          ),
        ),
        h(
          "div",
          { className: "dslt-launch" },
          h(
            "div",
            { className: "dslt-launch-row" },
            h(
              "label",
              { className: "dslt-filter" },
              h("span", { className: "dslt-filter-label" }, "连接主机"),
              h(
                "select",
                {
                  className: "dslt-select dslt-host-select",
                  value: effectiveHost,
                  onChange: function pick(event) {
                    setPickedHost(event.target.value);
                  },
                  "data-remote-terminal-host": "picker",
                  "aria-label": "选择要连接的主机",
                  disabled: overviewHosts.length === 0,
                },
                overviewHosts.length === 0
                  ? h("option", { value: "" }, "没有可用主机")
                  : overviewHosts.map(function option(host) {
                      const suffix = typeof host.target === "string" && host.target.length > 0 ? " · " + host.target : "";
                      const blocked = host.allowed === false;
                      return h(
                        "option",
                        { value: host.name, key: host.name, disabled: blocked },
                        host.name + (host.viaHost ? " · " + connectionProfileLabel(host) : suffix) + (blocked ? "（被 allowHosts 阻止）" : ""),
                      );
                    }),
              ),
            ),
            h(
              "button",
              {
                className: "dslt-btn dslt-btn-primary",
                type: "button",
                "data-terminal-action": "open",
                onClick: function openClick() { openOrTalk(false); },
                disabled: connecting || !terminalEnabled || !terminalAvailable || effectiveHost === "",
                title: "在右侧原生终端打开这台主机的 SSH 会话",
              },
              connecting ? "打开中…" : "打开终端",
            ),
            h(
              "button",
              {
                className: "dslt-btn",
                type: "button",
                "data-terminal-action": "talk",
                onClick: function talkClick() { openOrTalk(true); },
                disabled: connecting || !terminalEnabled || !terminalAvailable || effectiveHost === "",
                title: "打开终端并把当前对话交给 agent 接管",
              },
              "连接并对话",
            ),
            h(
              "button",
              {
                className: "dslt-btn",
                type: "button",
                "data-terminal-action": "copy-command",
                onClick: function copyCommandClick(event) { copyConnectCommand(event); },
                disabled: connecting || effectiveHost === "",
                title: "复制连接命令，可粘贴到任意终端执行（建立共享 SSH 连接）" +
                  (effectiveHostView && effectiveHostView.viaHost ? "；" + connectionProfileLabel(effectiveHostView) : ""),
              },
              "复制连接命令",
            ),
            terminalInfo !== null && terminalInfo.enabled === false
              ? h("span", { className: "dslt-launch-hint" }, "用户终端未启用")
              : terminalInfo !== null && terminalInfo.available === false
                ? h("span", { className: "dslt-launch-hint" }, "终端中继未就绪")
                : null,
          ),
          h(
            "p",
            { className: "dslt-launch-note" },
            "打开后会新建 DSH 原生终端标签并在其中建立 SSH 连接/已连接的会话可再次接入（复用同一 SSH 会话）",
            effectiveHostView && effectiveHostView.viaHost
              ? "。" + connectionProfileLabel(effectiveHostView) + "。" + PROFILE_NOTE + " " + TERMINAL_ONLY_NOTE : "",
          ),
          h(RemoteNotice, { notice: activeNotice, onDismiss: dismissActiveNotice }),
          overviewError !== null
            ? h("div", { className: "dslt-launch-error" }, "读取主机列表失败：" + overviewError)
            : null,
          h(
            "div",
            { className: "dslt-sessions" },
            h("span", { className: "dslt-launch-label" }, "终端会话 (" + relaySessions.length + ")"),
            relaySessions.length === 0
              ? h("span", { className: "dslt-launch-hint" }, "当前没有用户终端会话")
              : relaySessions.map(function renderRelaySession(session, index) {
                  const key = typeof session.sessionKey === "string" ? session.sessionKey : "session-" + index;
                  return h(
                    "div",
                    { className: "dslt-session-row", key: key, "data-terminal-session": key },
                    h("span", { className: "dslt-session-host", title: terminalSessionHostLabel(session) }, session.host),
                    h(
                      "span",
                      { className: "dslt-session-state dslt-session-" + String(session.state || "unknown") },
                      terminalSessionStateLabel(session),
                    ),
                    h(
                      "span",
                      {
                        className: "dslt-session-attached",
                        "data-terminal-attached": String(typeof session.attached === "number" ? session.attached : 0),
                      },
                      "接入 " + (typeof session.attached === "number" ? session.attached : 0),
                    ),
                    h(
                      "span",
                      { className: "dslt-session-key", title: key, "data-terminal-key": key },
                      shortSessionKey(key),
                    ),
                    actionProgressText(session.actionProgress) ? h("span", { className: "dslt-action-progress", role: "status", "aria-live": "polite", "data-terminal-action-progress": session.actionProgress.state }, actionProgressText(session.actionProgress)) : null,
                    relaySessionReused(session)
                      ? h(
                          "span",
                          {
                            className: "dslt-badge dslt-badge-reuse",
                            "data-terminal-reuse": "true",
                            title: "同一 SSH 会话被重新接入",
                          },
                          "复用",
                        )
                      : null,
                    h(
                      "button",
                      {
                        className: "dslt-btn dslt-btn-sm",
                        type: "button",
                        "data-terminal-action": "attach",
                        onClick: function attachClick() { attachRelaySession(session); },
                        disabled: connecting,
                      },
                      "打开",
                    ),
                    h(
                      "button",
                      {
                        className: "dslt-btn dslt-btn-sm dslt-btn-danger",
                        type: "button",
                        "data-terminal-action": "close",
                        onClick: function closeClick() { closeRelaySession(session); },
                      },
                      "关闭",
                    ),
                  );
                }),
          ),
        ),
        h(
          "div",
          { className: "dslt-body" },
          h(
            "div",
            { className: "dslt-log", ref: logRef, onScroll: onScroll, "aria-live": "polite" },
            visible.length === 0 ? empty : visible.map(renderLiveCommand),
          ),
          atBottom
            ? null
            : h(
                "button",
                { className: "dslt-jump", type: "button", onClick: stickToBottom },
                "回到底部 ↓",
              ),
        ),
      );
    }

    /** Optional live chip title; without it the chip shows the registered title. */
    function RemoteTerminalTitle() {
      return h(
        "span",
        { className: "dslt-chip" },
        h("span", { className: "dslt-chip-glyph", "aria-hidden": "true" }, ">_"),
        LIVE_TITLE,
      );
    }

    const OPS_CSS = [
      ".dshr-page{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}",
      ".dshr-scroll{flex:1;min-height:0;overflow-y:auto;padding:28px clamp(20px,4vw,44px) 48px;scrollbar-gutter:stable}",
      ".dshr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}",
      ".dshr-title{margin:0 0 4px;font-size:20px;font-weight:600;line-height:28px}",
      ".dshr-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dshr-head-actions{display:flex;gap:8px;flex-wrap:wrap}",
      ".dshr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;transition:border-color .15s ease, background-color .15s ease}",
      ".dshr-btn:hover:enabled{border-color:var(--dsw-alias-label-secondary)}",
      ".dshr-btn:disabled{opacity:.5;cursor:default}",
      ".dshr-btn-sm{padding:2px 8px;font-size:11.5px}",
      ".dshr-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".dshr-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}",
      ".dshr-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:11px}",
      ".dshr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;margin-bottom:16px;overflow:hidden}",
      ".dshr-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;font-size:12.5px}",
      ".dshr-card-body{padding:6px 14px 12px;overflow-x:auto}",
      ".dshr-hint{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}",
      ".dshr-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:8px 0;margin:0}",
      ".dshr-table{width:100%;border-collapse:collapse;font-size:12px}",
      ".dshr-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;font-size:11px}",
      ".dshr-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}",
      ".dshr-table tr:last-child td{border-bottom:0}",
      ".dshr-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}",
      ".dshr-name{font-weight:600;display:block}",
      ".dshr-desc{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:1px}",
      ".dshr-tags{display:inline-flex;gap:4px;margin-top:2px}",
      ".dshr-tag{border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 5px;font-size:10px;color:var(--dsw-alias-label-secondary)}",
      ".dshr-badge{display:inline-block;border-radius:999px;padding:1px 7px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".dshr-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}",
      ".dshr-badge-err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}",
      ".dshr-risk-low{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)}",
      ".dshr-risk-gray{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)}",
      ".dshr-risk-high,.dshr-risk-write{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".dshr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshr-ok{color:var(--dsw-alias-state-success-primary);font-size:11px}",
      ".dshr-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px}",
      ".dshr-fail{color:var(--dsw-alias-state-error-primary);font-size:11px}",
      ".dshr-detail{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
      ".dshr-error{border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;margin-bottom:16px;font-size:12px}",
      ".dshr-preview{border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px;padding-top:8px}",
      ".dshr-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px}",
      ".dshr-pre{margin:0;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}",
      // v0.5: primary buttons, notices, modals, host form, audit/confirm dialogs.
      ".dshr-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600}",
      ".dshr-btn-primary:hover:enabled{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}",
      ".dshr-notice{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-radius:8px;padding:7px 12px;margin:0 0 12px;font-size:12px;line-height:1.5}",
      ".dshr-notice-info{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".dshr-notice-error{border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-state-error-primary)}",
      ".dshr-notice-text{flex:1 1 auto;min-width:0;word-break:break-word}",
      ".dshr-notice-close{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:15px;line-height:1;padding:0 2px;opacity:.8}",
      ".dshr-notice-close:hover{opacity:1}",
      // v0.5.1: attach-failure notice with the copyable launch command.
      ".dshr-notice-body{display:flex;flex-direction:column;gap:5px;flex:1 1 auto;min-width:0}",
      ".dshr-notice-command-block{display:flex;flex-direction:column;gap:5px;min-width:0}",
      ".dshr-notice-command{margin:0;max-height:120px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}",
      ".dshr-notice-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshr-notice-hint{color:var(--dsw-alias-label-secondary);font-size:10px;word-break:break-word}",
      // v0.5.1: Recent Operations header export menu.
      ".dshr-card-tools{display:flex;align-items:center;gap:8px;position:relative}",
      ".dshr-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;gap:2px;min-width:132px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.22)}",
      ".dshr-menu-item{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;text-align:left;padding:4px 8px;border-radius:5px;cursor:pointer;white-space:nowrap}",
      ".dshr-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // v0.5.1: expandable audit rows with the full (whitespace-preserved) detail.
      ".dshr-audit-row{cursor:pointer}",
      ".dshr-audit-row-open td{background:var(--dsw-alias-bg-layer-2)}",
      ".dshr-audit-expand{border:0;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:11px;padding:0;white-space:nowrap}",
      ".dshr-audit-expand:hover{text-decoration:underline}",
      ".dshr-audit-detail-cell{padding:0 8px 8px;background:var(--dsw-alias-bg-layer-2)}",
      ".dshr-audit-full{margin:0;max-height:320px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}",
      ".dshr-modal-layer{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42))}",
      ".dshr-modal{box-sizing:border-box;width:100%;max-width:520px;max-height:min(82vh,760px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden}",
      ".dshr-modal-wide{max-width:720px}",
      ".dshr-modal-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}",
      ".dshr-modal-title{font-weight:600;font-size:14px}",
      ".dshr-modal-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 16px;scrollbar-gutter:stable}",
      ".dshr-modal-foot{flex:none;display:flex;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 16px}",
      ".dshr-modal-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}",
      ".dshr-confirm-text{margin:0;font-size:12.5px;line-height:1.7}",
      ".dshr-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}",
      ".dshr-actions-editor{margin-top:16px}.dshr-actions-heading{font-size:12px;margin:0;font-weight:600}.dshr-action-list{list-style:none;padding:0;margin:12px 0;display:flex;flex-direction:column;gap:12px}.dshr-action-row{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dshr-action-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px}.dshr-action-toolbar strong{font-size:11px;margin-right:auto}.dshr-action-row textarea{resize:vertical;font:inherit}",
      ".dshr-field{display:flex;flex-direction:column;gap:3px;min-width:0;margin:0 0 10px}",
      ".dshr-field-wide{grid-column:1 / -1}",
      ".dshr-field-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:500}",
      ".dshr-field-required{color:var(--dsw-alias-state-error-primary);margin-left:2px}",
      ".dshr-input{box-sizing:border-box;width:100%;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px}",
      ".dshr-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".dshr-textarea{resize:vertical;min-height:44px;line-height:1.5}",
      ".dshr-field-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}",
      ".dshr-form-note{margin:10px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}",
      ".dshr-form-error{margin-top:10px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-state-error-primary);border-radius:6px;padding:6px 10px;font-size:11.5px;word-break:break-word}",
      ".dshr-workbench{display:grid;grid-template-columns:minmax(216px,252px) minmax(0,1fr);gap:12px;align-items:stretch;min-height:340px;margin:2px 0 20px}",
      ".dshr-connections,.dshr-host-workspace{box-sizing:border-box;min-width:0;min-height:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}",
      ".dshr-connections{display:flex;flex-direction:column;height:480px;align-self:start}",
      ".dshr-connections-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dshr-connections-title{margin:0 0 3px;font-size:13px;font-weight:600}",
      ".dshr-connections-count{color:var(--dsw-alias-label-tertiary);font-size:10.5px}",
      ".dshr-connections-head,.dshr-connections-search,.dshr-connections-footnote{flex:none}\n.dshr-connections-search{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}\n.dshr-host-nav{display:flex;flex:1;flex-direction:column;gap:3px;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:6px}\n.dshr-host-nav .dshr-host-option{flex:none}",
      ".dshr-host-option{display:flex;flex-direction:column;gap:4px;width:100%;min-height:64px;padding:8px 9px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}",
      ".dshr-host-option:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshr-host-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".dshr-host-option-selected{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}",
      ".dshr-host-option-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
      ".dshr-host-option-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}",
      ".dshr-host-option-target{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
      ".dshr-host-option-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px}",
      ".dshr-host-option-indicator,.dshr-host-state-indicator{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:10px}",
      ".dshr-host-option-indicator::before,.dshr-host-state-indicator::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}",
      ".dshr-host-state-ok{color:var(--dsw-alias-state-success-primary)}",
      ".dshr-host-state-wait{color:var(--dsw-alias-state-warn-primary)}",
      ".dshr-host-state-error{color:var(--dsw-alias-state-error-primary)}",
      ".dshr-host-state-idle{color:var(--dsw-alias-label-tertiary)}",
      ".dshr-connections-empty{display:flex;flex-direction:column;gap:5px;padding:16px 12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}",
      ".dshr-connections-empty strong{color:var(--dsw-alias-label-primary);font-size:12px}",
      ".dshr-connections-footnote{margin:auto 12px 0;padding:10px 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}",
      ".dshr-host-workspace{padding:18px}",
      ".dshr-host-detail{display:flex;flex-direction:column;gap:14px;min-height:100%}",
      ".dshr-host-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dshr-host-identity{min-width:0}",
      ".dshr-host-eyebrow{color:var(--dsw-alias-label-tertiary);font-size:10px}",
      ".dshr-host-title{margin:4px 0 3px;font-size:20px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}",
      ".dshr-host-target{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".dshr-host-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}",
      ".dshr-host-status-line{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}",
      ".dshr-host-status-copy{min-width:0;overflow-wrap:anywhere}",
      ".dshr-host-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
      ".dshr-host-fact{display:flex;flex-direction:column;gap:4px;min-width:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px}",
      ".dshr-host-fact span{color:var(--dsw-alias-label-tertiary);font-size:10px}",
      ".dshr-host-fact strong{color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:500;overflow-wrap:anywhere}",
      ".dshr-host-description{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}",
      ".dshr-host-description p{margin:0 0 6px}",
      ".dshr-host-terminal-note{margin-top:auto;padding:12px 14px;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:0 7px 7px 0;background:var(--dsw-alias-bg-layer-2)}",
      ".dshr-host-terminal-note strong{font-size:11.5px;font-weight:600}",
      ".dshr-host-terminal-note p{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}",
      ".dshr-host-empty{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:9px;min-height:300px;max-width:440px;margin:0 auto;padding:24px}",
      ".dshr-host-empty-mark{color:var(--dsw-alias-state-success-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:20px;font-weight:600}",
      ".dshr-host-empty h2{margin:0;font-size:16px;font-weight:600}",
      ".dshr-host-empty p{margin:0 0 4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
      "@media (max-width:720px){.dshr-scroll{padding:16px 12px 32px}.dshr-head{flex-direction:column;align-items:stretch}.dshr-form-grid{grid-template-columns:minmax(0,1fr)}.dshr-workbench{grid-template-columns:minmax(0,1fr);min-height:0}.dshr-connections{height:320px}.dshr-host-detail-head{flex-direction:column}.dshr-host-actions{justify-content:flex-start}.dshr-host-facts{grid-template-columns:minmax(0,1fr)}}",
    ].join("\n");

    const LIVE_CSS = [
      ".dslt-panel{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;overflow:hidden}",
      ".dslt-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}",
      ".dslt-head-main{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dslt-action-progress{flex:1 1 100%;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".dslt-title{font-weight:600;font-size:12.5px;white-space:nowrap}",
      ".dslt-conn{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".dslt-conn::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;opacity:.85}",
      ".dslt-conn-on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)}",
      ".dslt-conn-wait{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent)}",
      ".dslt-conn-off{color:var(--dsw-alias-label-tertiary)}",
      ".dslt-session{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}",
      ".dslt-head-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dslt-filter{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap}",
      ".dslt-select{font:inherit;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 6px;max-width:170px}",
      ".dslt-btn{font:inherit;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 8px;cursor:pointer;white-space:nowrap}",
      ".dslt-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dslt-count{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".dslt-body{position:relative;flex:1 1 auto;min-height:0;display:flex}",
      ".dslt-log{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 12px 16px;scrollbar-gutter:stable;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.55}",
      ".dslt-empty{display:flex;flex-direction:column;gap:4px;padding:12px 4px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}",
      ".dslt-empty p{margin:0}",
      ".dslt-empty-hint{color:var(--dsw-alias-label-tertiary)}",
      ".dslt-cmd{margin:0 0 12px}",
      ".dslt-cmd:last-child{margin-bottom:0}",
      ".dslt-prompt{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px;min-width:0}",
      ".dslt-dollar{color:var(--dsw-alias-state-success-primary);font-weight:600;flex:none}",
      ".dslt-command{color:var(--dsw-alias-label-primary);font-weight:600;white-space:pre-wrap;word-break:break-word;min-width:0}",
      ".dslt-meta{color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap}",
      ".dslt-meta-session{opacity:.8}",
      ".dslt-tool{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap}",
      ".dslt-output{margin:2px 0 0 14px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".dslt-status{margin:2px 0 0 14px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:pre-wrap;word-break:break-word}",
      ".dslt-status-done{color:var(--dsw-alias-label-tertiary)}",
      ".dslt-status-running{color:var(--dsw-alias-state-warn-primary)}",
      ".dslt-status-error{color:var(--dsw-alias-state-error-primary)}",
      ".dslt-jump{position:absolute;right:12px;bottom:10px;font:inherit;font-size:10.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 10px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.16)}",
      ".dslt-chip{display:inline-flex;align-items:center;gap:5px;min-width:0}",
      ".dslt-chip-glyph{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;letter-spacing:-1px}",
      // v0.5 launcher: host picker, open/talk buttons, relay session list.
      ".dslt-launch{flex:none;display:flex;flex-direction:column;gap:6px;padding:6px 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}",
      ".dslt-launch-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
      ".dslt-launch-label{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".dslt-launch-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".dslt-launch-note{margin:0;font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}",
      ".dslt-launch-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary);word-break:break-word}",
      ".dslt-host-select{max-width:200px}",
      ".dslt-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600}",
      ".dslt-btn-primary:hover:enabled{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}",
      ".dslt-btn:disabled{opacity:.5;cursor:default}",
      ".dslt-btn-sm{padding:1px 6px;font-size:10.5px}",
      ".dslt-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".dslt-sessions{display:flex;flex-direction:column;gap:3px}",
      ".dslt-session-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary)}",
      ".dslt-session-host{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}",
      ".dslt-session-state{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;white-space:nowrap}",
      ".dslt-session-connected{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)}",
      ".dslt-session-connecting,.dslt-session-reconnecting{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)}",
      ".dslt-session-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".dslt-session-closed{color:var(--dsw-alias-label-tertiary)}",
      ".dslt-session-attached{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".dslt-session-key{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}",
      ".dslt-badge{display:inline-block;border-radius:999px;padding:0 6px;font-size:10px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".dslt-badge-reuse{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}",
      // Shared inline notice (panel + page use the same markup).
      ".dshr-notice{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-radius:8px;padding:6px 10px;font-size:11px;line-height:1.5}",
      ".dshr-notice-info{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".dshr-notice-error{border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-state-error-primary)}",
      ".dshr-notice-text{flex:1 1 auto;min-width:0;word-break:break-word}",
      ".dshr-notice-close{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0 2px;opacity:.8}",
      ".dshr-notice-close:hover{opacity:1}",
      // v0.5.1: attach-failure notice with the copyable launch command.
      ".dshr-notice-body{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-width:0}",
      ".dshr-notice-command-block{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dshr-notice-command{margin:0;max-height:110px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 7px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-all}",
      ".dshr-notice-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dshr-notice-hint{color:var(--dsw-alias-label-tertiary);font-size:10px;word-break:break-word}",
    ].join("\n");

    const plugin = {
      name: "dsh-remote",
      inject: ["slots"],
      apply: function apply(ctx) {
        try {
        // The v0.5 helpers resolve optional services from this root context at
        // call time; capturing it also keeps the management page independent of
        // whether the terminal/session UI packages are composed.
        runtimeCtx = ctx;
        passwordDisposed = false;
        ctx.effect(function passwordLifetime() {
          return disposePasswordRequests;
        }, "dsh-remote: browser password lifetime");
        ctx.effect(function registerPasswordOverlay() {
          return ctx.slots.inject("shell.overlay", function declared() {
            return ctx.slots.register(
              { name: "shell.overlay", id: "dsh-remote-auth", order: 100 },
              PasswordOverlay,
            );
          });
        }, "dsh-remote: global password overlay");
        ensureStyles();
        ensureLiveStyles();
        ctx.effect(function liveFeedLifetime() {
          return function cleanup() {
            liveFeed.dispose();
          };
        }, "dsh-remote: live terminal stream");
        ctx.effect(function registerPanel() {
          return ctx.slots.inject("sidebar.panellist", function declared() {
            return ctx.slots.register(
              { name: "sidebar.panellist", id: PANEL_ID, order: 60, label: function label() { return "远程运维"; } },
              RemoteOpsIcon,
            );
          });
        }, "dsh-remote: sidebar panel entry");
        ctx.effect(function registerPage() {
          return ctx.slots.inject("main", function declared() {
            return ctx.slots.register({ name: "main", key: PANEL_ID }, RemoteOpsPage);
          });
        }, "dsh-remote: main panel page");

        // The right Sidebar services are optional for the management page, so
        // they are awaited separately (a composition without the right Sidebar
        // keeps the management page instead of failing to apply this plugin).
        ctx.inject(["sidebarRightTabs", "sidebarRight"], function liveTerminal(scope) {
          runtimeRight = scope.sidebarRight;
          scope.effect(function registerLiveType() {
            return scope.sidebarRightTabs.register({
              id: LIVE_TAB_ID,
              kind: LIVE_TAB_ID,
              title: function title() { return LIVE_TITLE; },
              guide: [
                {
                  id: "remote-terminal",
                  order: 30,
                  title: function guideTitle() { return LIVE_TITLE; },
                  description: function guideDescription() { return LIVE_GUIDE_DESCRIPTION; },
                },
              ],
            });
          }, "dsh-remote: live terminal tab type");

          scope.effect(function registerLiveBody() {
            return scope.slots.inject("sidebar.right.pane.tab", function declared() {
              return scope.slots.register(
                { name: "sidebar.right.pane.tab", key: LIVE_TAB_ID },
                RemoteTerminalPanel,
              );
            });
          }, "dsh-remote: live terminal panel body");

          scope.effect(function registerLiveTitle() {
            return scope.slots.inject("sidebar.right.pane.tab.title", function declared() {
              return scope.slots.register(
                { name: "sidebar.right.pane.tab.title", key: LIVE_TAB_ID },
                RemoteTerminalTitle,
              );
            });
          }, "dsh-remote: live terminal tab title");

          // Auto-open: the first live `start` for the session on screen opens the
          // tab once, when the Host overview reports live.autoOpen. The feed is
          // started here so the trigger exists before any panel is mounted.
          scope.effect(function registerAutoOpen() {
            let disposed = false;
            let autoOpenFlag = false;
            let flagsSettled = false;
            let pendingStart = null;
            const autoOpened = new Set();

            function onScreenSessionId() {
              try {
                const mounted = scope.sidebarRight.mounted;
                const value =
                  mounted !== null && mounted !== undefined && typeof mounted.getSnapshot === "function"
                    ? mounted.getSnapshot()
                    : undefined;
                return typeof value === "string" && value.length > 0 ? value : null;
              } catch {
                return null;
              }
            }

            function tabAlreadyOpen(sessionId) {
              try {
                const tabs = scope.sidebarRight.tabsIn(sessionId);
                if (!Array.isArray(tabs)) return false;
                return tabs.some(function isLive(tab) {
                  return tab !== null && tab !== undefined && tab.kind === LIVE_TAB_ID;
                });
              } catch {
                return false;
              }
            }

            function maybeAutoOpen(event) {
              if (disposed || event === null || event === undefined) return;
              if (!flagsSettled) {
                if (pendingStart === null) pendingStart = event;
                return;
              }
              if (!autoOpenFlag) return;
              const onScreen = onScreenSessionId();
              if (onScreen === null) return;
              const eventSession = typeof event.sessionId === "string" ? event.sessionId : null;
              if (eventSession !== null && eventSession !== onScreen) return;
              if (autoOpened.has(onScreen)) return;
              if (tabAlreadyOpen(onScreen)) {
                autoOpened.add(onScreen);
                return;
              }
              autoOpened.add(onScreen);
              try {
                scope.sidebarRight.openTab(LIVE_TAB_ID);
              } catch (error) {
                autoOpened.delete(onScreen);
                try {
                  console.warn(
                    "[dsh-remote] could not auto-open the live terminal:",
                    error !== null && error !== undefined && error.message ? error.message : String(error),
                  );
                } catch {
                  /* ignore */
                }
              }
            }

            const unsubscribe = liveFeed.subscribeEvents(function onFeedEvent(event) {
              if (event !== null && event !== undefined && event.type === "start") {
                maybeAutoOpen(event);
              }
            });
            loadLiveFlags().then(function flagsLoaded(value) {
              if (disposed) return;
              flagsSettled = true;
              autoOpenFlag = value.enabled === true && value.autoOpen === true;
              if (value.enabled) liveFeed.ensureStarted();
              if (autoOpenFlag && pendingStart !== null) {
                const start = pendingStart;
                pendingStart = null;
                maybeAutoOpen(start);
              }
            });
            return function cleanup() {
              disposed = true;
              unsubscribe();
            };
          }, "dsh-remote: live terminal auto-open");

          // The shared browser terminal views are optional too: without this
          // package the panel still renders and the opener reports a clear error.
          scope.inject(["webTerminals"], function nativeTerminal(terminalScope) {
            runtimeTerminals = terminalScope.webTerminals;
          });
        });

        // Quick connect needs the Session controller and the main-view binding
        // source; both are optional so the page keeps working without them.
        ctx.inject(["sessions", "uiSession"], function sessionHandoff(scope) {
          runtimeSessions = scope.sessions;
          runtimeUiSession = scope.uiSession;
        });
        // Main-view navigation (conversation reveal before the terminal opens).
        ctx.inject(["uiWorkspace"], function workspaceNavigation(scope) {
          runtimeUiWorkspace = scope.uiWorkspace;
        });
        } catch (error) {
          try {
            console.error("[dsh-remote] client apply failed", error && (error.stack || String(error)));
          } catch {
            /* ignore */
          }
          throw error;
        }
      },
    };

    return plugin;
    } catch (error) {
      try {
        console.error("[dsh-remote] client factory failed", error && (error.stack || String(error)));
      } catch {
        /* ignore */
      }
      throw error;
    }
  },
});
