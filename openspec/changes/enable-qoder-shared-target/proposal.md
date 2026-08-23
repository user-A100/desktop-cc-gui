# enable-qoder-shared-target

## Why

`add-qoder-engine` 把 Qoder CLI 接到了 L1 Native（`acp-stdio`，spawn-per-turn + `session/resume`），但 Shared 资格被显式后置（picker disabled + write gate fail-closed）。2026-08-22 黄金 turn 与 Shared 语境补采完成（`docs/research/mossx-qoder-capability-spike.md` §13/§14，probe6/7/8/9/10/11）：

- typed terminal：prompt response `stopReason:"end_turn"` + `userMessageId` + usage shape；
- typed cancel：`session/cancel` → `stopReason:"cancelled"`（非 error，无迟到 chunk）；
- 跨进程 multi-turn continuation：进程 A 建 session 植入事实 → kill → 进程 B `session/resume` 正确回忆（probe10）——即 Shared binding re-attach 路径；
- pendingProbe：`session/list`（cwd 作用域）可见 mossx 创建的 session（probe11）；
- provider profile 隔离：`--config-dir` 下 create/kill/resume/list 全部成立（probe11）。

结论：Qoder 达到 Kimi/Grok/OpenCode/PI 同档 Shared 准入标准（接入指南 §0 F 层 + Step 2 ACK 分档）。用户需要：在 Shared Session 的四级 target picker 中选择 Qoder CLI 收发 turn，并能在 Qoder 与其他 CLI 之间逐 turn 切换。

## What Changes

- **F1 双集合**：前端 `SHARED_SESSION_SUPPORTED_ENGINES` 与后端 `is_supported_shared_session_engine()` 同 PR 加 `qoder`；`assertSharedSessionWriteEngine` 放行 qoder；picker 中 Qoder 从 disabled+reason 变为可选。
- **F2 `shared_session_v2.rs`**：`context_capabilities()` 加 Qoder 臂（`user_channel_transcript: true`，其余 false，`strong_context_ack: false`，与 Kimi/Grok/OpenCode/PI 同档）；`engine_runtime_key()` 与 native session id 恢复 match 补 Qoder 臂。
- **F3 `shared_runtime_coordinator.rs`**：`shared_pending_id` normalize 识别 `qoder-pending-shared-`；Qoder raw runtime ingress 必须结合 runtime owner 固化为 `qoder:<profile>:<raw>`，无 owner 的 raw ingress fail-closed。
- **F4 `shared_projection/commands.rs`**：投影能力 match + 支持引擎数组加 qoder。
- **F5 `shared_sessions.rs`**：`is_pending_shared_binding_thread_id` / `binding_uses_established_native_thread` Qoder 臂从 fail-closed 改为真实判断（`qoder-pending-shared-` 前缀 + `qoder:` 前缀 strip）；发送 dispatch match 加 qoder。
- **F15 Shared sidebar hide identity**：`SHARED_HIDE_ENGINE_PREFIXES` 加 `qoder`；canonical `qoder:<profile>:<sessionId>` 只命中同 profile，**禁止**展开 bare/raw alias。只有缺失 explicit owner 的历史 raw / `qoder:<raw>` 才走 Global-compatible hide。live 认主已由归档 `fix-shared-owned-native-sidebar-leak` 接线。禁止新增 Qoder 专属标题过滤。
- **F16 daemon/catalog V2 ownership recovery**：daemon 补齐既有前端调用的只读 `list_shared_sessions` RPC；其轻量 Shared adapter 与无 `SharedEventWriter` 的 catalog projection 必须复用既有只读 V2 binding 查询。V0 `bindings_by_engine` / `bindings_by_target` 为空时，按 `shared_session_id` 恢复 `shared_binding_state` / `binding.*` 的 profile-qualified current、archived identity，再交给既有 sidebar hide set。禁止标题猜测或 Shared 写路径副作用。
- **F17 Qoder Native identity**：Global/CN raw ACP sessionId 不保证跨 distribution 唯一。所有 durable Native / Shared / Session Index / metadata identity 统一为 `qoder:<providerProfileId>:<rawSessionId>`；raw ACP 只留 transport 边界，旧 raw 输入仅兼容 Global 或已有 explicit binding。
- Shared negative-path tests + 基石 §14.3.5 统一 Contract Test Suite 的 qoder 覆盖。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `shared-session-engine-selection`: Shared 支持集合从 6 引擎扩到 7 引擎（+ Qoder CLI）；picker / write gate / normalize 的 qoder 行为从 fail-closed 转为支持。本 delta **取代** `add-qoder-engine` 中「Shared Engine Exclusion Includes Qoder」排除 delta（该 change 归档时须相应修订或先于本 change 归档后由本 delta 覆盖）。
- `shared-session-thread`: Qoder Shared-owned native binding 与其裸 parent-id 下的 pup MUST 复用同级引擎 hide identity；daemon/catalog 在 V0 legacy metadata 不完整时 MUST 以 V2 durable binding 恢复精确 owner，且不得影响用户主动创建的 Qoder Native Session。

## 非目标

- L3 NativeHistoryReader / Provider Continuation（仍按后置记录独立 change）。
- structured history import / `native_delta` / `native_clone` / `strong_context_ack`（保持 false，等对应 ACP method probe 证据，禁止猜测打开）。
- Qoder 专属 usage 卡（ACP usage 字段 PAT 账号零值、`qoder.rs` 不解析）。
- `session.tree`、`plan` 事件、`session/close` / `session/delete` live 验证。
- 新增第三个 Qoder distribution、远程会话、SDK 面；Global/CN 双 distribution 已是本 change 的 identity boundary。

## 风险

- **R1（中）inputAck 弱语义**：qoder `inputAck: "first-event"`（与 Kimi 同级）。UI 与文档不假装 exactly-once；recovery 依赖 `session/list` probe + typed terminal。若后续观测到丢 turn，按 Kimi 同案处理。
- **R2（中）隐藏 flag / 版本漂移**：`--acp` 不在 `--help`；1.1.27→1.1.28 已发生一次 browser login 态丢失（PAT 不受影响）。capability cache key 含 version+sha256，版本变化重 probe。
- **R3（低）`session/list` cwd 作用域**：Shared binding 的 cwd 与创建时不一致时 probe 不到；binding 创建即持 exact sessionId，probe 仅作 recovery 辅助，不作 identity 来源。
- **R4（低）context 走 user channel**：长 ContextPackage 拼进 prompt 文本，token 成本与模型截断由通用 context compiler 预算控制；`strong_context_ack: false` 下不按 strong 语义承诺。
- **R5（低）daemon catalog 读 V2**：只读 SQLite 使用既有 200ms busy timeout，失败时保留 V0 projection 并记录 warning；不凭 title 隐藏任何会话，避免把独立 Native Session 误归属到 Shared。
- **R6（中）same-raw collision**：Global/CN 的 ACP raw sessionId 可能相同。canonical identity、metadata key、Session Index、runtime receipt 和 interrupt 必须同时携带 profile；canonical id 禁止扩展 bare/raw hide alias，旧 runtime 不支持 turn-scoped interrupt 时 Qoder 必须 fail-closed，不能降级为 workspace-wide interrupt。
