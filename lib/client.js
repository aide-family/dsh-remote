/**
 * dsh-remote browser half — the "Remote Ops" management page.
 *
 * Hand-written bundle in the DSH client module-loader format: the loader runs
 * this file, registers the factory, and materializes it lazily. The factory
 * returns a Cordis client plugin (`{ name, inject, apply }`).
 *
 * The page is a first-level sidebar panel:
 *   - `sidebar.panellist` list entry (icon) with id `dsh-remote`
 *   - `main` keyed entry with the same key (the page itself)
 *
 * Data comes from the Host API at `/dsh-remote/api` (same-origin POST, browser
 * cookie auth enforced Host-side by the connection fence).
 */
window.__ModuleLoader__.load({
  id: "dsh-remote",
  factory: function factory(require) {
    try {
    const React = require("react");
    const h = React.createElement;

    const API_URL = "/dsh-remote/api";
    const STYLE_ID = "dsh-remote/ops.css";
    const PANEL_ID = "dsh-remote";
    const REFRESH_MS = 10_000;

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      const style = document.createElement("style");
      style.dataset.plugin = PANEL_ID;
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = CSS;
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

    const CSS = [
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

    const plugin = {
      name: "dsh-remote",
      inject: ["slots"],
      apply: function apply(ctx) {
        try {
        ensureStyles();
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
