# add-qoder-dual-distribution design

> 上游：`proposal.md`、`docs/designs/qoder-distribution-options-v2.html`
>
> 外部事实：Qoder Global `qodercli --acp` / `QODER_CONFIG_DIR` /
> `QODER_PERSONAL_ACCESS_TOKEN`；Qoder CN `qoderclicn --acp` /
> `QODERCN_CONFIG_DIR` / `QODERCN_PERSONAL_ACCESS_TOKEN`。

## Context

Qoder 已作为一个 Native `acp-stdio` engine 接入。现有运行时把它假定为唯一
Global distribution：`qoderBin`、`__local_qoder__`、`~/.qoder`、
`qoder-auth.json` 与 engine-global model catalog 都只有一份。该假定在同时支持
`qodercli` 与 `qoderclicn` 时不成立。

本变更横跨 React 菜单/Composer/Settings、Tauri IPC、Rust Qoder runtime 与
Native History。实施必须避免两类既有事故：

- 切侧栏会话时触发 `get_engine_models` 的同步 IPC；
- 以全局当前设置替换 thread 已绑定的 runtime identity。

## Goals / Non-Goals

**Goals:**

- 用单一 `qoder` engine 表达 Global 与 CN 两个 stable distribution。
- 将 distribution 从选择、配置、认证、catalog、启动、发送、恢复到历史读取完整传递。
- 保持一个 Qoder 父入口与一个 Qoder Settings page；建立双 distribution 的配置卡。
- Global 与 CN 的状态失败、未安装、未登录和空目录互相隔离且可诊断。

**Non-Goals:**

- 不新增 `qoder-cn` engine id、单独顶层侧栏项或通用 provider CRUD。
- 不自动迁移或修改 vendor-owned `~/.qoder` / `~/.qoder-cn` 文件。
- 不在会话选择路径中 refresh catalog，也不将 Global catalog 降级给 CN。
- 不将未安装的 CN binary 推测为具有与 Global 完全相同的 ACP payload；实际运行以
  handshake 为准。

## Decisions

### D1. QoderDistribution 是 domain identity；profile id 只是 transport

定义 `global` / `cn` 两个 Qoder distribution，并以稳定特殊 profile id 承载在
`ExecutionTarget` 与 Native thread binding：

| Distribution | Profile id | Binary | Config env | PAT env | 默认 config root |
|---|---|---|---|---|---|
| Global | `__qoder_global__` | `qodercli` | `QODER_CONFIG_DIR` | `QODER_PERSONAL_ACCESS_TOKEN` | `~/.qoder` |
| CN | `__qoder_cn__` | `qoderclicn` | `QODERCN_CONFIG_DIR` | `QODERCN_PERSONAL_ACCESS_TOKEN` | `~/.qoder-cn` |

`__local_qoder__`、空 profile 与既有 `qoder:<sessionId>` 继续解释为 Global。
新建 Global/CN 会话一律记录显式 profile id，且 Qoder special ids **不得**经过
普通 local sentinel 归一化为 `null`。

Shared V2 在 Tx1 写入前必须使用同一 resolver 校验 Qoder profile。未知 profile id
返回 `target-unavailable`，且不得写入 `conversation.turnRequested` 或 Binding；只有
空值与 `__local_qoder__` 保留为 legacy Global compatibility。

选择这个方案而非新增两个 engine enum，是为了在 UI 保持一个品牌入口，同时让
session identity 可重放。选择这个方案而非全局地区 toggle，是为了避免历史会话在
配置切换后漂移。

### D2. 一个 resolved launch descriptor 是所有 Rust 路径的事实源

新增/扩展 `QoderDistributionLaunch`，由 distribution 与 App Settings 一次解析出：

- `distribution`、profile id 和 runtime key；
- binary（保留 `qoderBin` 为 Global compatibility，新增 CN custom binary）；
- config directory（显式 app setting → 对应官方 environment variable → 官方默认值）；
- PAT environment variable、旧 Global credential 的 compatibility lookup；
- history root。

status/doctor、`get_engine_models`、ACP spawn、send、fork、interrupt 与 history
必须都接收这个 descriptor 或同一 resolver 的结果。ACP 子进程通过正确的 config/PAT
environment 启动；不依赖只对 Global 文档成立的 `QODER_HOME`。这消除“探测看的是 A、
发送跑的是 B”的静默错配。

### D3. Catalog scope 必须包含 distribution，且只按需请求

现有 key `qoder:<providerProfileId>` 扩展为分发稳定 id；每一行 model 保留对应
profile id。Qoder 的 catalog 仍来自 ACP `session/new`/`session/resume` handshake，
不生成静态 fallback roster。

- 打开 Qoder model picker、用户点击刷新、或发送前确认缺 catalog，才允许请求；
- side bar session switch 只更新 identity/chrome，禁止 IPC；
- request/cache key 与 last-good snapshot 必须包括 distribution；
- catalog error/empty 只在同 distribution 中展示，不能 fallback 到另一个。

这复用 provider-target catalog 的 request dedupe 与 UI 结构，但 Qoder 的 profile
语义是 distribution，不触发 `vendor_switch_*` 或全局 L1 rewrite。

### D4. UI 用一个父入口和一个 Qoder page 展示双 distribution

侧栏 `Qoder CLI` 变为父 action，children 为 Global / CN。点击子项立即创建一个
带稳定 Qoder profile binding 的 Native thread；不能先修改全局 Qoder settings 再创建。

Qoder Vendor page 保持单 tab，并在页内以 `Global / CN` segmented tabs 展示一个 active
distribution panel。默认 Global；Qoder settings deep link 带 CN 时直接选中 CN。每个 panel
展示/管理自身：CLI path、config root、browser-login command、PAT 状态/编辑、doctor/status。
切换仅替换可见配置视图，不能触发 runtime rebinding 或 catalog refresh。认证文件采取
distribution-aware storage；现有 `qoder-auth.json` 留作 Global legacy credential，CN 使用独立
文件。所有 token 永远不进日志、arguments 或 UI snapshot。

### D5. Thread/session persistence 优先于当前 Settings

Native send 从 thread 的 persisted profile id 解析 distribution。Canonical promotion、
fork 与 continuation 均保留它。无 binding 的历史 Global session 使用 legacy resolver；
带 Global/CN binding 的 session 只读对应 history root / ACP endpoint。

session id 保留 `qoder:<sessionId>` compatibility format；distribution 不是靠字符串
prefix 猜测，而是靠 persisted binding。发生 source 不可读时，当前 distribution 的 ACP
fallback 才可执行，不能跨 distribution 扫描。

## Risks / Trade-offs

- **CN ACP payload 在本机尚未 live probe** → 以 shared ACP parser、fixture unit tests 和
  clear unavailable state 接入；有 binary 的人工验收必须验证 initialize/new/set_model。
- **legacy global settings/token 格式** → Global resolver 兼容旧 `qoderBin` 与
  `qoder-auth.json`；只新增字段，不破坏旧配置。
- **单 engine 的 profile semantics 容易被 generic normalizer 清空** → 在
  Qoder-specific normalizer 加 focused tests，明确 `__qoder_global__` / `__qoder_cn__`
  是 persistable。
- **catalog IPC 可能造成切会话卡顿** → 禁止在 session selection effect 接入 refresh；
  以 tests 断言 no-call，并沿用 on-demand/idle phase。
- **vendor UI 复杂度增加** → 使用同一可复用 card primitive/生命周期组件，不复制
  Generic provider CRUD。

## Migration Plan

1. 读取时将空/`__local_qoder__` Qoder profile 映射为 Global；不写回历史数据。
2. 现有 `qoderBin` 和 `qoder-auth.json` 继续作为 Global source；新字段只保存 CN 与
   optional distribution config roots。
3. 新 thread 从菜单创建时写显式 distribution binding；canonical promotion 保持绑定。
4. 若发布后回滚，旧版本仍可读取 Global 旧字段；CN-specific settings 和 bindings 被
   旧版本忽略，但不会删除 user data。

## Open Questions

- CN ACP handshake 的 model/reasoning payload 是否与 Global byte-for-byte 相同：不是
  launch blocker，runtime parser 以 ACP result 归一；完成前以 real `qoderclicn` 进行
  manual probe 并保留未验证结果。
- CN history file nesting 是否与 Global 完全相同：初期以 config root + existing tolerant
  reader，若 vendor layout 不匹配则回退该 distribution 的 ACP list/load；不得跨 root。
