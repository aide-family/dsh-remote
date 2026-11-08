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
