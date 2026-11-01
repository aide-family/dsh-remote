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
  id: "dsh-remote",
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

    /** DSH-native terminal opening bounds (docs/ARCHITECTURE.md, browser half). */
    const TERMINAL_TAB_WAIT_MS = 5_000;
    const TERMINAL_WRITABLE_WAIT_MS = 20_000;
    const CONVERSATION_WAIT_MS = 3_000;
    const WAIT_POLL_MS = 100;

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

    /** The right Sidebar service (native terminal tab placement). */
    function sidebarRightService() {
      const captured = runtimeRight !== null ? runtimeRight : runtimeService("sidebarRight");
      return captured !== null && captured !== undefined && typeof captured.openTabIn === "function"
        ? captured
        : undefined;
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
      return captured !== null && captured !== undefined && typeof captured.openSession === "function"
        ? captured
        : undefined;
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
      const workspace = uiWorkspaceService();
      if (workspace === undefined) {
        await nextPaint();
        return;
      }
      try {
        workspace.openSession(sessionId);
      } catch (error) {
        // Navigation failure is not fatal: the mounted wait below decides.
      }
      const mountedSource = (function readMountedSource() {
        const right = sidebarRightService();
        if (right === null || right === undefined) return undefined;
        const mounted = right.mounted;
        return mounted !== null && mounted !== undefined && typeof mounted.getSnapshot === "function" ? mounted : undefined;
      })();
      if (mountedSource !== undefined) {
        await waitForValue(
          function readMounted() { return mountedSource.getSnapshot(); },
          function sameSession(value) { return value === sessionId; },
          CONVERSATION_WAIT_MS,
          "切回对话视图超时：3 秒内主视图没有回到当前对话",
        ).catch(function ignoreTimeout() { return undefined; });
      }
      await nextPaint();
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

    /** Poll `read()` until `predicate` accepts its value, else reject with `message`. */
    function waitForValue(read, predicate, timeoutMs, message) {
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
          setTimeout(attempt, WAIT_POLL_MS);
        }
        attempt();
      });
    }

    /**
     * Open DSH's own native terminal for `sessionId` and type `command` into it.
     * This is the contract-minimal flow: open the tab, locate it in the
     * `sidebarRight.openTabs` snapshot, read the navigation address, obtain the
     * shared `webTerminals` view, wait for input control, then write. Every step
     * is feature-detected and failures carry an actionable Chinese message; the
     * caller shows it inline and nothing is restored on failure.
     *
     * @param {string} sessionId Owning conversation session.
     * @param {string} command Shell line to run in the new terminal tab.
     * @returns {Promise<void>}
     */
    async function openNativeTerminal(sessionId, command) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("无法打开原生终端：当前没有可用的对话会话");
      }
      if (typeof command !== "string" || command.length === 0) {
        throw new Error("无法打开原生终端：后端没有返回终端启动命令");
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
      const before = new Set();
      for (const tab of tabStore.getSnapshot() || []) {
        const id = tabIdOf(tab);
        if (id !== undefined) before.add(id);
      }
      try {
        right.openTabIn(sessionId, "terminal", {});
      } catch (error) {
        throw new Error("无法打开原生终端标签页：" + errorText(error));
      }
      const tabId = await waitForValue(
        function readNewTab() {
          const list = tabStore.getSnapshot() || [];
          for (const candidate of list) {
            const id = tabIdOf(candidate);
            if (id !== undefined && candidate.kind === "terminal" && !before.has(id)) return id;
          }
          return undefined;
        },
        function found(value) { return value !== undefined; },
        TERMINAL_TAB_WAIT_MS,
        "打开原生终端超时：5 秒内没有出现新的终端标签页",
      );
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
      let view;
      try {
        view = terminals.view(sessionId, tabId, navigation.address, undefined, undefined);
      } catch (error) {
        throw new Error("无法获取共享终端视图：" + errorText(error));
      }
      if (view === null || view === undefined || view.state === null || view.state === undefined || typeof view.state.getSnapshot !== "function" || typeof view.write !== "function") {
        throw new Error("终端服务不可用：终端视图接口不完整");
      }
      await waitForValue(
        function readState() { return view.state.getSnapshot(); },
        function writable(state) { return state !== null && state !== undefined && state.writable === true; },
        TERMINAL_WRITABLE_WAIT_MS,
        "原生终端 20 秒内未就绪（没有取得输入控制权）",
      );
      view.write(command + "\r");
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
    function handoffMessage(name, target) {
      const targetText = typeof target === "string" && target.length > 0 ? target : name;
      return (
        "已连接远程主机 " + name + "（" + targetText + "）。" +
        "请在当前对话里继续这台主机的运维：先做一次只读健康检查（hostname、uptime、磁盘、内存、负载），再等我的指令。"
      );
    }

    /**
     * Quick connect: create/reuse the relay SSH PTY, open the native terminal on
     * it, and (for 连接并对话) inject the handoff user message. The message is
     * never sent when the terminal failed.
     *
     * @param {{name: string, sessionId?: string | null, talk?: boolean}} options
     * @returns {Promise<{shell: any, sessionId: string | null, injected: boolean, notice: string | null}>}
     */
    async function connectHostTerminal(options) {
      const name = options !== null && options !== undefined ? options.name : "";
      if (typeof name !== "string" || name.length === 0) throw new Error("请先选择或指定一台主机");
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : null;
      const talk = options.talk === true;
      const opened = await callApi("terminal.open", sessionId === null ? { name: name } : { name: name, sessionId: sessionId });
      const shell = opened !== null && opened !== undefined ? opened.shell : null;
      if (shell === null || shell === undefined || typeof shell.command !== "string" || shell.command.length === 0) {
        throw new Error("后端没有返回终端启动命令，无法打开原生终端");
      }
      if (sessionId === null) {
        return {
          shell: shell,
          sessionId: null,
          injected: false,
          notice: "已创建 SSH 终端会话，但当前没有打开的对话，无法在侧栏打开原生终端或接管对话。",
        };
      }
      await openNativeTerminal(sessionId, shell.command);
      if (!talk) {
        return { shell: shell, sessionId: sessionId, injected: false, notice: null };
      }
      const target =
        shell.host !== null && shell.host !== undefined && typeof shell.host.target === "string"
          ? shell.host.target
          : opened.session !== null && opened.session !== undefined && typeof opened.session.target === "string"
            ? opened.session.target
            : name;
      await sendConversationMessage(sessionId, handoffMessage(name, target));
      return { shell: shell, sessionId: sessionId, injected: true, notice: null };
    }

    /** The label for one relay TerminalSessionView state. */
    function terminalStateLabel(state) {
      return TERMINAL_STATE_LABELS[state] || state || "未知";
    }

    /** Relay session target text (`host` + `target`) for the panel list. */
    function terminalSessionHostLabel(session) {
      const target = typeof session.target === "string" ? session.target : "";
      return target.length > 0 ? target : typeof session.host === "string" ? session.host : "—";
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

    async function callApi(method, params) {
      const response = await fetch(API_URL, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ method: method }, params || {})),
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
        throw new Error(message);
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

    /** Inline notice/toast for connect/inject failures and status messages. */
    function RemoteNotice(props) {
      const notice = props.notice;
      if (notice === null || notice === undefined) return null;
      const kind = notice.kind === "error" ? "error" : "info";
      return h(
        "div",
        {
          className: "dshr-notice dshr-notice-" + kind,
          "data-dsh-remote-notice": kind,
          "data-kind": kind,
          role: kind === "error" ? "alert" : "status",
        },
        h("span", { className: "dshr-notice-text" }, notice.text),
        typeof props.onDismiss === "function"
          ? h(
              "button",
              { className: "dshr-notice-close", type: "button", onClick: props.onDismiss, "aria-label": "关闭提示" },
              "×",
            )
          : null,
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
      return h(
        "div",
        {
          className: "dshr-modal-layer",
          onMouseDown: function backdrop(event) {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          "div",
          Object.assign(
            {
              className: "dshr-modal" + (props.wide === true ? " dshr-modal-wide" : ""),
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

    /** Empty form model for the add/edit host modal. */
    function emptyHostForm(host) {
      const source = host !== null && host !== undefined ? host : {};
      return {
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

      const fields = HOST_FORM_FIELDS.map(function renderField(description) {
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
            onChange: function change(event) {
              setField(description.key, event.target.value);
            },
          }),
          description.hint ? h("span", { className: "dshr-field-hint" }, description.hint) : null,
        );
      });

      return h(
        ModalShell,
        {
          title: mode === "edit" ? "编辑主机 · " + String(props.host && props.host.name ? props.host.name : "") : "添加主机",
          wide: true,
          rootAttrs: { "data-dsh-remote-host-form": mode },
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
        h("div", { className: "dshr-form-grid" }, fields),
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
          ? h("div", { className: "dshr-form-error", "data-host-form-error": "" }, "保存失败：" + error)
          : null,
      );
    }

    /** Per-host audit viewer (`audit.list { host }`). */
    function AuditModal(props) {
      const hostName = String(props.hostName || "");
      const [state, setState] = React.useState({ loading: true, error: null, entries: [], total: 0 });

      const load = React.useCallback(
        async function load() {
          setState(function pending(previous) {
            return { loading: true, error: null, entries: previous.entries, total: previous.total };
          });
          try {
            const result = await callApi("audit.list", { host: hostName, limit: 200 });
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

      const entries = state.entries;
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
                ),
              ),
              h(
                "tbody",
                null,
                entries.map(function renderEntry(entry, index) {
                  return h(
                    "tr",
                    { key: typeof entry.id === "string" ? entry.id : "entry-" + index, "data-audit-entry": "" },
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
                          className:
                            entry.outcome === "ok"
                              ? "dshr-ok"
                              : entry.outcome === "denied"
                                ? "dshr-warn"
                                : "dshr-fail",
                        },
                        entry.outcome,
                      ),
                    ),
                    h(
                      "td",
                      { className: "dshr-mono" },
                      typeof entry.durationMs === "number" ? entry.durationMs + "ms" : "—",
                    ),
                    h("td", { className: "dshr-detail", title: entry.detail }, entry.detail || "—"),
                  );
                }),
              ),
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
              { className: "dshr-btn", type: "button", "data-audit-action": "close", onClick: props.onClose },
              "关闭",
            ),
          ),
        },
        state.error !== null
          ? h("div", { className: "dshr-error" }, "读取审计记录失败：" + state.error)
          : rows,
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
       * Quick connect from the hosts table: open the relay SSH PTY, open DSH's
       * native terminal, and (when a conversation is on screen) inject the
       * handoff message so the agent takes the host over. The management page
       * never injects into an unknown session: it shows a notice instead.
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
          setNotice({ kind: "error", text: "连接失败：" + errorText(failure) });
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

      const hosts = (data && data.hosts) || [];
      const sessions = (data && data.sessions) || [];
      const audit = (data && data.audit) || [];

      return h(
        "div",
        { className: "dshr-page" },
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
              h(
                "button",
                {
                  className: "dshr-btn dshr-btn-primary",
                  type: "button",
                  "data-host-action": "create",
                  onClick: openCreateForm,
                },
                "添加主机",
              ),
              h("button", { className: "dshr-btn", onClick: clearAudit }, "清空操作记录"),
            ),
          ),
          error !== null
            ? h("div", { className: "dshr-error" }, "请求失败：" + error)
            : null,
          h(RemoteNotice, { notice: notice, onDismiss: function dismiss() { setNotice(null); } }),
          h(
            "div",
            { className: "dshr-chips" },
            h("span", { className: "dshr-chip" }, "审批策略：" + ((data && data.policy) || "?")),
            h("span", { className: "dshr-chip" }, "SSH 配置：" + ((data && data.sshConfigPath) || "~/.ssh/config")),
            h("span", { className: "dshr-chip" }, "只读主机：" + (((data && data.readonlyHosts) || []).join(", ") || "无")),
            h("span", { className: "dshr-chip" }, "允许主机：" + (((data && data.allowHosts) || []).join(", ") || "全部")),
          ),
          h(
            Card,
            { title: "远程主机 (" + hosts.length + ")", extra: h("span", { className: "dshr-hint" }, "来自 ~/.ssh/config、插件配置与托管主机；「连接」会打开真实 SSH 终端，「测试连接」只做只读探测") },
            hosts.length === 0
              ? h("p", { className: "dshr-empty" }, "还没有发现远程主机。在 ~/.ssh/config 中配置，或在插件配置的 hosts 列表中添加。")
              : h(
                  "table",
                  { className: "dshr-table" },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", null, "名称"),
                      h("th", null, "目标"),
                      h("th", null, "来源"),
                      h("th", null, "认证"),
                      h("th", null, "策略"),
                      h("th", null, "操作"),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    hosts.map(function renderHost(host) {
                      const result = testResults[host.name];
                      return h(
                        "tr",
                        { key: host.name },
                        h(
                          "td",
                          null,
                          h("span", { className: "dshr-name" }, host.name),
                          host.description ? h("span", { className: "dshr-desc" }, host.description) : null,
                          host.tags && host.tags.length > 0
                            ? h("span", { className: "dshr-tags" }, host.tags.map(function tag(t) { return h("span", { className: "dshr-tag", key: t }, t); }))
                            : null,
                        ),
                        h("td", { className: "dshr-mono" }, host.target),
                        h("td", null, host.source),
                        h("td", null, host.authHint),
                        h(
                          "td",
                          null,
                          host.readonly ? h("span", { className: "dshr-badge dshr-badge-warn" }, "只读") : null,
                          host.allowed ? (host.readonly ? null : h("span", { className: "dshr-badge" }, "可写")) : h("span", { className: "dshr-badge dshr-badge-err" }, "被 allowHosts 阻止"),
                        ),
                        h(
                          "td",
                          { className: "dshr-actions" },
                          h(
                            "button",
                            {
                              className: "dshr-btn dshr-btn-sm dshr-btn-primary",
                              type: "button",
                              "data-host-action": "connect",
                              "data-host-name": host.name,
                              onClick: function connectClick() { runQuickConnect(host.name, true); },
                              disabled: connectingHost !== "" || host.allowed === false,
                              title: host.allowed === false ? "被 allowHosts 阻止" : "打开 SSH 终端",
                            },
                            connectingHost === host.name ? "连接中…" : "连接",
                          ),
                          h(
                            "button",
                            {
                              className: "dshr-btn dshr-btn-sm",
                              type: "button",
                              "data-host-action": "audit",
                              "data-host-name": host.name,
                              onClick: function auditClick() { setAuditHost(host); },
                            },
                            "审计",
                          ),
                          h(
                            "button",
                            {
                              className: "dshr-btn dshr-btn-sm",
                              type: "button",
                              "data-host-action": "test",
                              "data-host-name": host.name,
                              onClick: function testClick() { testHost(host.name); },
                              disabled: testing === host.name,
                            },
                            testing === host.name ? "测试中…" : "测试连接",
                          ),
                          host.managed === true
                            ? h(
                                "button",
                                {
                                  className: "dshr-btn dshr-btn-sm",
                                  type: "button",
                                  "data-host-action": "edit",
                                  "data-host-name": host.name,
                                  onClick: function editClick() { openEditForm(host); },
                                },
                                "编辑",
                              )
                            : null,
                          host.managed === true
                            ? h(
                                "button",
                                {
                                  className: "dshr-btn dshr-btn-sm dshr-btn-danger",
                                  type: "button",
                                  "data-host-action": "delete",
                                  "data-host-name": host.name,
                                  onClick: function deleteClick() { setDeleteHost(host); },
                                },
                                "删除",
                              )
                            : null,
                          result
                            ? h(
                                "span",
                                { className: result.ok ? "dshr-ok" : "dshr-fail" },
                                result.ok
                                  ? "连接正常 " + result.latencyMs + "ms" + (result.output ? " · " + result.output : "")
                                  : "失败：" + (result.error || "未知错误"),
                              )
                            : null,
                        ),
                      );
                    }),
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
            { title: "最近操作 (" + audit.length + ")", extra: h("span", { className: "dshr-hint" }, "审计记录保存在 $DSH_HOME/remote/audit.jsonl") },
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
                              className:
                                entry.outcome === "ok"
                                  ? "dshr-ok"
                                  : entry.outcome === "denied"
                                    ? "dshr-warn"
                                    : "dshr-fail",
                            },
                            entry.outcome,
                          ),
                        ),
                        h("td", { className: "dshr-mono" }, entry.durationMs + "ms"),
                        h("td", { className: "dshr-detail", title: entry.detail }, entry.detail),
                      );
                    }),
                  ),
                ),
          ),
          // v0.5 overlays live inside this page component (no global DOM).
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
          const result = await connectHostTerminal({ name: effectiveHost, sessionId: sessionId, talk: talk });
          setPanelNotice(
            result.notice !== null && result.notice !== undefined
              ? { kind: "info", text: result.notice }
              : { kind: "info", text: talk ? "已打开终端并发送接管消息：" + effectiveHost : "已打开终端：" + effectiveHost },
          );
          await refreshOverview();
        } catch (failure) {
          setPanelNotice({ kind: "error", text: "连接失败：" + errorText(failure) });
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
        try {
          const opened = await callApi("terminal.open", { name: session.host, sessionId: sessionId });
          const shell = opened !== null && opened !== undefined ? opened.shell : null;
          if (shell === null || shell === undefined || typeof shell.command !== "string" || shell.command.length === 0) {
            throw new Error("后端没有返回终端启动命令");
          }
          await openNativeTerminal(sessionId, shell.command);
          setPanelNotice({ kind: "info", text: "已重新接入终端会话：" + session.host });
          await refreshOverview();
        } catch (failure) {
          setPanelNotice({ kind: "error", text: "接入失败：" + errorText(failure) });
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
                        host.name + suffix + (blocked ? "（被 allowHosts 阻止）" : ""),
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
            terminalInfo !== null && terminalInfo.enabled === false
              ? h("span", { className: "dslt-launch-hint" }, "用户终端未启用")
              : terminalInfo !== null && terminalInfo.available === false
                ? h("span", { className: "dslt-launch-hint" }, "终端中继未就绪")
                : null,
          ),
          h(RemoteNotice, { notice: panelNotice, onDismiss: function dismiss() { setPanelNotice(null); } }),
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
                      terminalStateLabel(session.state),
                    ),
                    h(
                      "span",
                      { className: "dslt-session-attached" },
                      "接入 " + (typeof session.attached === "number" ? session.attached : 0),
                    ),
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
      "@media (max-width:720px){.dshr-scroll{padding:16px 12px 32px}.dshr-head{flex-direction:column;align-items:stretch}.dshr-form-grid{grid-template-columns:minmax(0,1fr)}}",
    ].join("\n");

    const LIVE_CSS = [
      ".dslt-panel{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;overflow:hidden}",
      ".dslt-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}",
      ".dslt-head-main{display:flex;align-items:center;gap:8px;min-width:0}",
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
      ".dslt-launch-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary);word-break:break-word}",
      ".dslt-host-select{max-width:200px}",
      ".dslt-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600}",
      ".dslt-btn-primary:hover:enabled{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}",
      ".dslt-btn:disabled{opacity:.5;cursor:default}",
      ".dslt-btn-sm{padding:1px 6px;font-size:10.5px}",
      ".dslt-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".dslt-sessions{display:flex;flex-direction:column;gap:3px}",
      ".dslt-session-row{display:flex;align-items:center;gap:6px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary)}",
      ".dslt-session-host{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}",
      ".dslt-session-state{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;white-space:nowrap}",
      ".dslt-session-connected{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)}",
      ".dslt-session-connecting,.dslt-session-reconnecting{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)}",
      ".dslt-session-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".dslt-session-closed{color:var(--dsw-alias-label-tertiary)}",
      ".dslt-session-attached{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      // Shared inline notice (panel + page use the same markup).
      ".dshr-notice{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-radius:8px;padding:6px 10px;font-size:11px;line-height:1.5}",
      ".dshr-notice-info{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".dshr-notice-error{border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-state-error-primary)}",
      ".dshr-notice-text{flex:1 1 auto;min-width:0;word-break:break-word}",
      ".dshr-notice-close{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0 2px;opacity:.8}",
      ".dshr-notice-close:hover{opacity:1}",
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
