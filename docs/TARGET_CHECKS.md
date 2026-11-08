# 运行时目标检查

目标检查是独立的远程命令安全能力，用于明确校验当前命令执行环境。

## 页面配置

打开 **远程运维**，在主机列表选中逻辑主机／场地，点击主机详情的 **目标检查**。

- 添加检查名称、读取事实的命令和精确预期值。
- 页面托管检查使用版本 CAS 保存，保存不执行任何远程命令。
- 配置文件中的检查是只读的，不能从页面移除；托管检查与它们限制性合并。
- 修改预期值后，审批中的旧请求不能沿用旧批准执行。

也可在插件的 `profiles[].targetChecks` 配置，例如：

```yaml
profiles:
  - name: cluster-a-identity
    hosts: [cluster-a]
    environment: production
    targetChecks:
      - name: login-user
        command: id -un
        expected: root
      - name: kube-context
        command: kubectl config current-context
        expected: cluster-a
```

以上是示例，预期值必须由操作人独立确认。不要从别名猜测，也不要用常量 echo 输出冒充身份检查。不要在检查命令或预期值中填写密码/token。

## 命令执行保护

- 最多 10 个有效检查，每项命令／预期最多 4096 UTF-8 字节。
- 要求检查成功退出及 stdout 精确匹配，只忽略末尾换行。
- 有冲突、缺失、失败、重复帧、截断或未知结果就停止。
- 高风险／未知 exec 先采集事实供审批，再把检查和操作放在同一 POSIX 命令上下文重核验。
- 原始命令和探测不支持已知上下文覆盖、包装器及复杂 shell 语法绕过。目标检查不是任意 shell 的安全沙箱，也不是密码学主机证明。
- 审批后、派发前重新核验当前 allow/readonly/never/deny 策略、检查摘要和逻辑连接路由；新开启检查不能把旧批准升级为新执行。
- 直连 exec 使用 `/bin/sh`；未支持的平台失败关闭。

## PTY 与显式准备

先通过 `remote_shell_open` 取得此 Agent 实际拥有的 PTY。对输入状态未知的目标检查 PTY，需要明确请求：

```text
remote_target_check(host="cluster-a", session_id="实际拥有的PTY ID", reset_input=true)
```

重置可能中断前台程序和清空输入，必须单独批准，且不能绕过只读锁或 never 策略。所有目标检查 PTY 的提交命令，包括只读命令，都需要有效当前通道租约和明确退出帧。人工接管、信号、断线和未知输出使准备失效。

Agent 提交必须是一条可打印行；C0/ESC/DEL/Tab/内部 Enter 被拒绝。raw 输入需独立审批，不能含 Enter，目标检查 PTY 不接受 raw/partial 输入。不要用 Agent 输入凭据；输入参数可能出现在对话中。原始输入不写入操作审计或直播命令头。

逻辑目标路由包括 SSH 坐标、用户、跳板及可信连接动作。旧 PTY 不能冒充更新后的场地路由。已保存的可信初始化仍保留此前免 Agent 审批的行为，不因此免除后续检查。

## 文件系统视图限制

exec 检查不能证明 SFTP subsystem 的 chroot/namespace/path view。启用目标检查的主机拒绝文件写入、编辑、恢复和传输；SFTP read/list 明确标注未获目标证明。未配置检查的直连主机保留现有安全文件流程。

不要为了绕过限制临时删检查；未来文件系统身份能力需要独立证据。外部并发修改、自定义 CLI 内部选择的目标和已经开始的远端操作不能被此守卫自动撤销。
