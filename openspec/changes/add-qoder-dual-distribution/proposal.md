# add-qoder-dual-distribution

## Why

当前 Qoder Native 接入只识别 Global `qodercli`：一个 `qoderBin`、一个
`~/.qoder` home、一个 PAT 与一个 `__local_qoder__` profile。Qoder CN 使用
独立 binary `qoderclicn`、`QODERCN_CONFIG_DIR` 与
`QODERCN_PERSONAL_ACCESS_TOKEN`；若直接复用当前 Qoder runtime，会发生账号、
模型目录、会话与历史来源串线。

用户已确认客户端形态：侧栏保留一个 **Qoder CLI** 父入口，展开后选择
**Global** 或 **CN**；供应商页在同一个 Qoder 页面内管理两套配置。模型选择器
必须按已选 distribution 的 ACP catalog 工作，而不是按普通 Native provider 或全局
Qoder catalog 猜测。

## 目标与边界

- 将 Qoder Global 与 Qoder CN 建模为同一 `qoder` engine 的两个
  `QoderDistribution`：`global`、`cn`。
- 每个 distribution 独立解析 binary、config home、PAT、ACP model catalog、
  runtime ownership 与 thread binding。
- 保持一个 Qoder 侧栏父入口与一个 Qoder 供应商设置页；不新增独立的 Qoder CN
  顶层 engine。
- 既有 `qoder:<sessionId>` Global thread 必须兼容为 `global`；新的会话必须持久化
  distribution binding，历史会话切换不得改变该绑定。

## 非目标

- 不接入 Qoder remote/cloud session、SDK 或 Qoder 专属计费面。
- 不把 Global/CN 做成用户可编辑的通用 API provider CRUD。
- 不在切换侧栏会话、恢复历史或全局设置切换时拉取 ACP model catalog。
- 不修改 Qoder ACP 协议语义；CN 的 live capability probe 未通过时必须 fail closed，
  不以 Global 的模型或认证结果替代 CN。

## 方案对比

### 方案 A：Global 与 CN 各自成为顶层 CLI engine

优点是 runtime 最直观；缺点是侧栏、引擎 registry、Shared picker、历史标签和设置
入口都出现重复的 Qoder 品牌，违背已确认的单父入口体验，也增加 engine 枚举 fan-out。

### 方案 B：单一 Qoder engine + distribution-scoped binding（采用）

`providerProfileId` 仅作为持久化 transport，语义上是不可变的 distribution binding。
每个 binding 指向自己的 binary/home/auth/catalog/runtime key。UI 可复用现有
provider-profile 菜单结构，但禁止走“切换当前供应商即改变旧会话”的路径。

### 方案 C：单一 Qoder engine + 全局地区开关

实现最少，但会让旧会话在用户改设置后路由到另一地区；模型缓存和登录态也会被覆盖。
不能满足 session identity 可重放要求，拒绝。

## What Changes

- 新增 Qoder distribution domain 与稳定 profile id：Global / CN 各自拥有 CLI binary、
  config directory、PAT 存储和 runtime key；legacy `__local_qoder__` 兼容映射为
  Global。
- 将 Qoder status、doctor、ACP spawn、模型发现、send、interrupt、fork、history
  的配置解析统一改为 distribution-aware，确保每次运行使用同一套 binary/home/auth。
- 新建会话菜单将 Qoder CLI 改为父项，子项为 Global / CN；创建路径持久化所选
  distribution，且不创建额外顶层 CLI 入口。
- Qoder 供应商页展示并独立管理 Global / CN 两张配置卡：安装/路径、浏览器登录、PAT
  与状态均按 distribution 隔离。
- 模型选择器对 Qoder distribution 建立独立 catalog key；只能展示所选 distribution 的
  ACP 模型，且只在打开 picker、手动刷新、发送前确缺目录时请求。
- 历史/侧栏投影保存或恢复 Qoder distribution binding，避免 Global/CN session sources
  互相读取、续接或覆盖。

## Capabilities

### New Capabilities

- `qoder-dual-distribution`: Qoder Global/CN 的 runtime、credential、ACP catalog、
  session/history isolation，以及单父入口与双配置页行为。

### Modified Capabilities

- `engine-per-session-provider-binding`: Qoder distribution 必须作为 session-scoped
  immutable binding 持久化；不得被全局设置或其他 distribution 重路由。
- `provider-model-catalog-refresh`: Qoder catalog cache 与 refresh 必须按
  distribution scope 区分，并且不得落在会话切换热路径。
- `composer-model-selector-config-actions`: Qoder model picker 必须先确定
  distribution，再显示该 distribution 的 ACP catalog 与配置动作。

## Impact

- Rust：`src-tauri/src/engine/qoder*.rs`、`status.rs`、`commands.rs`、`manager.rs`、
  settings/doctor command、session binding/history paths。
- Frontend：Qoder settings/auth UI、sidebar new-session menu、composer target/catalog
  owner、model selector、Tauri service types 与 i18n。
- Persistence：新增兼容的 Global/CN Qoder configuration and credential records；不迁移、
  不删除用户的 `~/.qoder` 或 `~/.qoder-cn` 数据。

## 验收标准

- Qoder CLI 在新建会话菜单中只有一个父入口，Global/CN 均可创建并携带独立 binding。
- Global 与 CN 在同一 workspace 可并行运行；任一 distribution 的 model、PAT、home、
  runtime/session 不得被另一个使用。
- 已绑定的历史 Qoder 会话切换时不触发 `get_engine_models` IPC，也不被当前设置覆盖。
- Qoder model picker 不得在 CN 状态异常时显示 Global catalog，反之亦然。
- 现有 Global Qoder thread 和设置保持可用；strict OpenSpec validation、focused
  TypeScript/Rust tests 及相关 quality gates 通过。
