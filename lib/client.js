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

    function RemoteOpsPage() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [testResults, setTestResults] = React.useState({});
      const [testing, setTesting] = React.useState("");
      const [preview, setPreview] = React.useState(null);

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
              h("button", { className: "dshr-btn", onClick: clearAudit }, "清空操作记录"),
            ),
          ),
          error !== null
            ? h("div", { className: "dshr-error" }, "请求失败：" + error)
            : null,
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
            { title: "远程主机 (" + hosts.length + ")", extra: h("span", { className: "dshr-hint" }, "来自 ~/.ssh/config 与插件配置；「测试连接」只做只读探测") },
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
                              className: "dshr-btn dshr-btn-sm",
                              onClick: function testClick() { testHost(host.name); },
                              disabled: testing === host.name,
                            },
                            testing === host.name ? "测试中…" : "测试连接",
                          ),
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
      const logRef = React.useRef(null);
      const stickRef = React.useRef(true);
      const feed = liveFeed;
      const snapshot = feed.getSnapshot();

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
    ].join("\n");

    const plugin = {
      name: "dsh-remote",
      inject: ["slots"],
      apply: function apply(ctx) {
        try {
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
