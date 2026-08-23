# fix-shared-owned-native-sidebar-leak design

> 上游：`openspec/changes/fix-shared-owned-native-sidebar-leak/proposal.md`
> 实机：Shared 主幕三引擎正确 + 侧栏下崽；冷启等几秒 hide 补齐后崽消失
> 依赖：`enable-qoder-shared-target` F17 identity 原语（`canonicalQoderThreadId` / hide keys）；本设计不平行再造
> 关联：`fix-shared-sidebar-hide-set-staleness`（Grok/Kimi 异步 hide 已修，PI/Qoder 仍漏）；`restore-sidebar-background-scan-sqlite`（last-good floor 会记住泄漏行）

## Context

发送链（V2 + `sharedOwner`）把 turn 写进 Shared，所以主幕对。泄漏链是另一条：

1. ACP / runtime 建 session → `thread/started`
2. 生产路径仍调用 `resolvePendingSharedSessionBindingForEngine(workspace, engine)`
3. 同 engine 两条 pending（两条 Shared，或 Qoder Global+CN）→ fail-closed `null`
4. `sharedBridge` 空 → `onThreadSessionIdUpdated` / `onThreadStarted` → `ensureThread` 画出 Native
5. Qoder finalized 公式仍是 `` `${engine}:${sessionId}` ``，与 Index canonical `qoder:<profile>:<raw>` 分叉
6. Index first-paint 在 hide 未就绪时 full-show；V2 visibility busy timeout 仅 200ms
7. 冷启后 `listSharedSessions` + quiet Index soft re-sync（800ms–8s）才把崽藏掉

`resolvePendingSharedSessionBindingForTarget` 已存在且测试按 Target 认主；**生产未接**。

## Goals / Non-Goals

**Goals:**

- Live 认主按 Target，认回即停 Native 开行
- Qoder 终态 id 带 distribution；Grok/PI lookup 走 identity keys
- `ensureThread` 认 Shared-owned，不靠 `parent.startsWith("shared:")`
- hide 未就绪不放出新 grok/pi/qoder Index 行，同时保住 last-good 真 Native
- PI/Qoder 异步 refresh 与 Grok/Kimi 同构重建 hide

**Non-Goals:**

- 不重做 F16 V2-only ownership recovery、F17 canonical 生成 / Index migration
- 不改发送契约、ACP、recovery exit
- 不回退 empty-hide fail-closed
- 不清理磁盘 orphan jsonl

## Decisions

### D1 生产路径改接已有 Target resolver（不用再写第三套认主）

`useAppServerEvents` `thread/started` 用 `resolvePendingSharedSessionBindingForTarget(workspace, engine, providerProfileId)`。事件缺 profile 时：Qoder fail-closed 不认（避免 Global/CN 串线）；Grok/PI 允许 `null`（它们不是 dual-distribution）。

拒绝继续扩 engine-only 白名单：那正是把 Claude/Codex 正确逻辑扩坏的原因。

### D2 Qoder finalized id 只走 canonical helper

```ts
const finalizedNativeThreadId =
  eventEngine === "qoder"
    ? canonicalQoderThreadId(sessionId, providerProfileId)
    : `${eventEngine}:${sessionId}`;
```

`canonicalQoderThreadId` 失败则不 rebind、不 `ensureThread`。helper 由 `enable-qoder-shared-target` F17 提供；本 change 只接线。对方 F14 注释已写终态带 profile，代码未接——本 change 接管 live 接线，避免两家各写一份。

### D3 `ensureThread` 增加 Shared-owned 闸，而不是只修 parent 字段

Grok/Qoder `thread/started` 经常不带 `parent: shared:`。闸门顺序：

1. id 已是 `shared:` → 放行 Shared 行
2. id 命中 hide / pending-shared / 已登记 binding（identity keys）→ 丢弃
3. 其余走现有 Native ensure

`isPendingEngineThreadId` 必须把 `qoder-pending-` / `qoder-pending-shared-` 算进去。

### D4 hide 未就绪：last-good 保留，新 Shared-engine native 延后

改 `buildNativeIndexEarlyPaintSummaries` / `canProjectIndexNatives` 的实际行为，使其匹配现有注释「Never paint ordinary native Index rows with an empty/unverified hide set」。

- visibility `verified` 或已有 last-verified hide → 按 hide 投影 Index
- 否则：只投影 last-good 中非 Shared-owned 的 native + 已有 Shared 行
- 新 grok/pi/qoder Index 行等 `listSharedSessions` 之后的最终 apply
- `unionIndexWithNewerLastGood` 不得把已知泄漏 id 并回权威列表

禁止 empty-hide 藏掉全部 native（Windows Grok 蒸发）。

### D5 PI / Qoder 异步 refresh 抄 Grok/Kimi hide rebuild

`shouldRefreshPiSessions` / `shouldRefreshQoderSessions` 目前复用 list 开头的 `hiddenSharedBindingIds`。改为：

- `listSharedSessions` 重建 hide
- fresh ∪ outer
- `requestSeq` 再校验
- merge 后 `stripHiddenSharedBindingSummaries`

Grok/Kimi 已在 `fix-shared-sidebar-hide-set-staleness` 落地，本 change 不重写那两条，只补 PI/Qoder 并加回归钉。

### D6 Rust 只做漏认补丁，不重做 identity

若实现时仍看到：

- `findBindingsByNativeThread` 精确字符串、未走 Qoder identity keys
- `bindings_by_engine` 规范化 `provider_profile_id = None` 把 CN raw 当 Global

则做最小补丁。F16/F17 的 migration / daemon RPC **不动**。若对方尚未合入，本任务标 blocked，不在脏树上叠。

### D7 实现闸门：等对方停手，不并行改同一批文件

提案可先落盘。Apply 前核对 `enable-qoder-shared-target` 是否仍占用：

`useThreadActions.ts`、helpers、`sharedHideIdentity.ts`、`shared_sessions.rs`、`shared_binding_visibility.rs`、`session_index/**`、`useAppServerEvents.ts`

对方停手或合入后再改。`useAppServerEvents.ts` 当前几乎只有注释，是本 change 最干净的切入点。

## Risks / Trade-offs

- **R1（中）hide 未就绪延后新 grok/pi/qoder 行** → 用户刚用 Native 自己建的会话，冷启可能晚几秒才出现。Mitigation：只延后「不在 last-good、且 hide 未就绪」的新行；用户真 Native 一旦进 last-good 就持续可见。不得延后 Claude/Codex 已验证路径。
- **R2（中）与 F17 脏树冲突** → Mitigation：D7 等待；identity helper 以对方落地版本为准。
- **R3（低）Target 事件缺 profile** → Qoder fail-closed 宁可晚 hide，也不串 Global/CN。Grok/PI 允许 null。
- **R4（低）last-good 仍可能短暂记住泄漏行** → 最终 apply 与 hide 命中后必须 purge；冷启 last-good 是内存 ref，重启自然清空，不作为正确性依赖。

## Migration Plan

- 无需数据迁移。pending 在下次 `thread/started` 或 list hide 时收敛。
- 回滚：还原 `useAppServerEvents` 认主与早画闸即可；发送契约未动。
- 不整段 revert dual-distribution。

## Open Questions

- `enable-qoder-shared-target` 是否会在本 change apply 前自己落地 F14 live 接线？若会，本 change 只补 Target resolver + 早画闸 + PI/Qoder async hide，不再重复 canonical 公式。
- `bindings_by_engine` 的 `provider_profile_id = None` 是否已在对方 F17 修掉？Apply 时再核对，避免重复。
