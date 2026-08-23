# fix-shared-owned-native-sidebar-leak

## Why

Shared 主幕已经能把 Grok / Qoder Global / Qoder CN / PI 写进同一条 `shared:*` 会话，但 **live `thread/started` 仍按 engine-only 认主**，再叠加 Session Index 早画与 hide 未就绪 full-show，Shared 刚拉起的 Native binding 会先作为独立会话出现在侧栏（下崽）。冷启等几秒后 hide 从磁盘补齐，崽会自己消失——这证明 **持久化 hide 最终能对上，live 认主和早画闸门没有对上**。现在修，是因为 dual-distribution 与新引擎接入把这条不变量从 Claude/Codex 特判扩坏了，且用户已用实机图钉死。

## 目标与边界

- Shared 拥有的 Native binding（含 pending → canonical 晋升）**不得**进入用户侧栏顶栏 / 子行。
- 生产路径 `thread/started` 必须按 **Target**（`engine + providerProfileId`）认 pending，禁止再靠 `resolvePendingSharedSessionBindingForEngine`。
- Qoder finalized id 必须是 `qoder:<profile>:<raw>`；Grok / PI 保持 `engine:raw`，但 lookup / hide 走 identity keys，禁止只做精确字符串匹配。
- Index 早画在 hide 未就绪时，**不得把新出现的 grok / pi / qoder native 行当权威画出来**；不得回退 0.9.1 empty-hide fail-closed（那会蒸发 Windows Grok 真 Native）。
- 用户自己建的 Native 会话必须继续可见。
- 本 change 只修 **认主 / hide / 早画闸**；不改 Shared 发送契约、ACP 协议、也不新增 distribution。

## 非目标

- 不重做 `enable-qoder-shared-target` 的 F16（daemon/catalog V2-only ownership recovery）和 F17（Qoder canonical identity 生成 / Session Index migration）。本 change **消费**那些 identity 原语，不平行再造一份。
- 不清理磁盘 orphan jsonl；用户可手动删。
- 不改 Shared V2 send / recovery exit / context compiler。
- 不把 hide 未就绪改回 empty-hide fail-closed。
- 不新增第三个 Qoder distribution，不改 Global/CN 产品形态。

## What Changes

- **Live 认主**：`useAppServerEvents` 的 `thread/started` 改走 `resolvePendingSharedSessionBindingForTarget`；Qoder 必须带 `__qoder_global__` / `__qoder_cn__`。同 workspace 两条 pending 不得串线、不得 fail-closed 成 Native 开行。
- **Finalized id**：禁止 `${engine}:${sessionId}` 作为 Qoder 终态；用 `canonicalQoderThreadId`。认回 Shared 后 `return`，不得再 `ensureThread` / `onThreadStarted`。
- **`ensureThread` Shared-owned 闸**：命中 hide set / pending-shared / 已登记 binding 的 native id 直接不进侧栏；禁止只认 `parent.startsWith("shared:")`。
- **Hide 未就绪早画**：Index first-paint 在 visibility 非 `verified` 且本进程尚无 last-verified hide 时，只保留 last-good / 已验证 hide 内的 native；**新出现的 grok / pi / qoder Index 行等 `listSharedSessions` 回来再决定**。last-good 不得把泄漏行做成权威。
- **异步 refresh 对齐**：PI / Qoder 异步扫盘路径按 Grok/Kimi 同构重建 hide set（fresh Shared list ∪ outer），禁止 stale 空集把崽 merge 回来。
- **测试先红后绿**：双 pending 不串线、串行 Grok→Qoder Global→PI 侧栏只留 Shared、canonical hide 盖住扫盘行、用户自建 Native 不被误藏。

### 方案对比与取舍

| 方案 | 说明 | 取舍 |
|------|------|------|
| **A. 只修 Qoder identity alias** | canonical hide 再展开 `qoder:raw` | 拒绝：Grok/PI 同样下崽；canonical 展开会让 Global/CN 撞 raw |
| **B. 取消 Index 早画，全部等 Shared list** | 从根上消灭时序窗 | 拒绝：冷启侧栏会回到 stale snapshot，和 Session Index 首屏契约冲突 |
| **C. 回退 empty-hide fail-closed** | hide 未就绪先藏全部 native | 拒绝：`rewrite-shared-hide-list-prefilter` 已证明会蒸发 Windows Grok 真 Native |
| **D. Target 认主 + ensureThread 闸 + 早画不放出新 native（采用）** | 修 live 漏画，hide 迟到只做兜底 | **采用**：发送契约不动；与 `enable-qoder-shared-target` identity 正交 |

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `shared-session-thread`：把「Shared-owned Native 不得进侧栏」从 hide-after-the-fact 提升为 **live 认主不变量**；补 Target pending 认主、finalized id、`ensureThread` 闸、pending→canonical 立刻进 hide。
- `shared-hide-list-prefilter`：hide 未就绪策略从「last-good / full-show 全部 Index native」收窄为「last-good + 已验证 hide；禁止放出新的 grok/pi/qoder native」。仍禁止 empty-hide fail-closed。

## Impact

- Frontend：`useAppServerEvents.ts`（live 认主）、`useThreadActions.ts` / helpers（早画闸、PI/Qoder async hide）、`ensureThread` 调用链、focused Vitest。
- Identity 消费：`canonicalQoderThreadId` / `collectQoderSessionIdentityKeys` / `resolvePendingSharedSessionBindingForTarget`（已存在，测试已按 Target 认主，**生产未接**）。
- Rust：仅当 `isPendingEngineThreadId` / `findBindingsByNativeThread` / `bindings_by_engine` 规范化仍按 engine-only 漏认时做最小补丁；不重做 F16/F17。
- Specs：`shared-session-thread`、`shared-hide-list-prefilter` delta。
- ADR：若 `findBindingsByNativeThread` / pending 晋升改到 canonical fact 或 provider binding 读取公式，收口前按 `AGENTS.md` ADR 校准 Gate 回写基石「零、当前实现校准」。默认预期 **不改** canonical fact schema。
- 依赖：实现起步应等 `enable-qoder-shared-target` F17 identity 原语停手或合入（见下方并行判断）；提案本身不改那份工作树。

## 与当前工作区其他 AI 的关系

工作树正在改的是 `enable-qoder-shared-target`（F15 hide keys / F16 V2 recovery / F17 canonical id），脏文件与本 change **高度重叠**：

| 文件 | 对方在做 | 本 change 要做 | 冲突 |
|------|----------|----------------|------|
| `qoderSessionIdentity.ts`、`qoder_provider_profile.rs`、`session_index/**` | F17 canonical id | **只读消费** | 低，等他们停手 |
| `sharedHideIdentity.ts`、`shared_binding_visibility.rs`、`shared_sessions.rs` | F15/F16 hide keys + V2 nativeThreadIds | lookup 互认、pending 进 hide | **中高** |
| `useThreadActions.ts` / helpers | Qoder list 用 canonical id | 早画闸 + PI/Qoder async hide rebuild | **高** |
| `useAppServerEvents.ts` | 目前只改了 F14 注释；公式仍是 `engine:sessionId` + engine-only pending | **本 change 主战场** | 目前可切走；若对方开始写 F14 则撞车 |

对方 **没有**覆盖：生产路径 Target 认主、Grok/PI 双 pending、`ensureThread` Shared-owned 闸、hide 未就绪不再 full-show。`fix-shared-sidebar-hide-set-staleness` 已修 Grok/Kimi 异步 stale hide，PI/Qoder 同构路径仍漏。

**落地校准（2026-08-22）：** 对方 F17 已停手。本 change 已叠在其 identity 原语上实现 live 认主 / ensureThread 闸 / 早画闸 / PI·Qoder async hide。对方 design F14（`thread/started` 终态 `qoder:<profile>:<raw>`）原先只改了注释，由本 change 接线。

对方提案准确性：

- F15 tasks 文案仍写「复用 raw / engine: identity 展开」，与 design D8 / 代码不一致：canonical Global/CN **不**展开 bare/raw alias。以 D8 与 `collectQoderSessionIdentityKeys` 为准。
- F16/F17 identity + V2 nativeThreadIds 恢复已在工作树；Phase 3.1 实机目视仍未勾。
- `bindings_by_engine` 的 `provider_profile_id = None` 是 V0 default binding 同步，不是 CN 被当成 Global 的现活洞；Qoder durable 走 `bindings_by_target`。
- 工作树 `useThreadActions.helpers.test.ts` 现有 3 红（continuation 标题 / Agent 12 / Codex hide uuid），属于对方 catalog/title 改动，不是本 change 引入。

## 验收标准

- Shared 串行 `3+3` Grok → `1=1` Qoder Global → PI：主幕三轮都在同一条 Shared；侧栏 **不得**出现同标题 Grok/Qoder/PI 顶栏或挂在其下的崽。
- 同 workspace 两条 Shared 同时 pending Grok（或 Qoder Global+CN）：不得串线，也不得 Native 开行。
- canonical `qoder:__qoder_global__:<raw>` 扫盘行被 hide；legacy `qoder:<raw>` 只当 Global 兼容；用户自建 Qoder/Grok Native 仍可见。
- 冷启 first-paint 即使 hide 晚到，也不得先把刚扫到的 Shared-owned grok/pi/qoder 行画成权威 native。
- `openspec validate fix-shared-owned-native-sidebar-leak --strict --no-interactive` 通过。
- focused Vitest（`useAppServerEvents` / `sharedHideIdentity` / `sharedSessionBridge` / `useThreadActions` 早画与 PI/Qoder hide）全绿；相关 Rust identity 测试不扩大既有红。
