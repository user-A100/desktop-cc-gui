# fix-shared-owned-native-sidebar-leak tasks

> 实现闸门：等 `enable-qoder-shared-target` 对重叠文件停手或合入后再 apply。
> 身份原语（`canonicalQoderThreadId` / hide keys）由对方 F17 提供，本 change 只接线。
> 纪律：先红后绿；不改发送契约。

## 1. OpenSpec + 冲突闸门

- [x] 1.1 [P0] `openspec validate fix-shared-owned-native-sidebar-leak --strict --no-interactive` 通过
- [x] 1.2 [P0] 核对工作树：对方 `enable-qoder-shared-target` F17 已停手，本 change 叠在其 identity 原语上实现
- [x] 1.3 [P0] 确认 `canonicalQoderThreadId` / `collectQoderSessionIdentityKeys` / `resolvePendingSharedSessionBindingForTarget` 已可 import

## 2. 先红测试

- [x] 2.1 [P0] 同 workspace 两条 Shared pending Grok：`thread/started` 不得 Native 开行、不得串线（`useAppServerEvents` / `sharedSessionBridge`）
- [x] 2.2 [P0] Qoder Global+CN 双 pending + 相同 raw：各自认到自己的 canonical id，canonical hide 不展开 raw alias
- [x] 2.3 [P0] 串行 Grok → Qoder Global → PI：侧栏只留 Shared；Qoder 不得挂在 Grok native 下（2026-08-22 用户手测通过）
- [x] 2.4 [P0] hide 未就绪：新 grok/pi/qoder Index 行不得 early-paint；last-good 真 Native 保留；empty-hide fail-closed 不得回归
- [x] 2.5 [P1] 用户自建 Grok/Qoder Native 不被误藏；legacy `qoder:<raw>` 只当 Global 兼容

## 3. Live 认主

- [x] 3.1 [P0] `useAppServerEvents` `thread/started` 改走 `resolvePendingSharedSessionBindingForTarget`；生产路径删除 engine-only 认主权威
- [x] 3.2 [P0] Qoder finalized id 用 `canonicalQoderThreadId(sessionId, providerProfileId)`；禁止 `` `${engine}:${sessionId}` ``。失败则不 rebind、不 `ensureThread`
- [x] 3.3 [P0] 认回 Shared 后 `return`，不得再 `onThreadStarted` / `onThreadSessionIdUpdated`
- [x] 3.4 [P1] `isPendingEngineThreadId` 覆盖 `qoder-pending-` / `qoder-pending-shared-`（及 `pi-pending-`）

## 4. ensureThread 闸 + hide 立刻晋升

- [x] 4.1 [P0] `ensureThread`：hide set / pending-shared / 已登记 binding（identity keys）命中则不进侧栏；不靠 `parent.startsWith("shared:")`
- [x] 4.2 [P0] pending → canonical 晋升后立刻把 canonical keys 并进 hide / last-verified hide（live 认回即 return；bridge lookup 走 identity keys）
- [x] 4.3 [P1] `findBindingsByNativeThread` 改为 identity keys。`bindings_by_engine` 的 `provider_profile_id = None` 是 V0 default binding 语义，F17 已把 Qoder 放到 `bindings_by_target`，跳过

## 5. 早画闸 + 异步 hide

- [x] 5.1 [P0] Index first-paint：visibility 未 verified 且无 last-verified hide 时，不 full-show 新 grok/pi/qoder 行；等 `listSharedSessions` 后再决定
- [x] 5.2 [P0] last-good 不得把已知泄漏 Shared-owned id 并回权威列表（union 后 strip hide）
- [x] 5.3 [P0] PI / Qoder 异步 refresh：重建 hide（fresh ∪ outer）+ `requestSeq` 再校验 + baseline strip。不重写已修的 Grok/Kimi 路径，只加回归钉

## 6. 验证

- [x] 6.1 [P0] 2.x 先红测试转绿；focused Vitest：`useAppServerEvents` / `sharedSessionBridge` / `sharedHideIdentity` / `useThreadActions` 早画与 PI/Qoder hide（190 focused 全绿）
- [x] 6.2 [P1] 相关 Rust identity / pending 测试不扩大既有红（本 change 未改 Rust identity；peer 树 `useThreadActions.helpers.test.ts` 3 红与本 change 无关）
- [x] 6.3 [P0] `openspec validate fix-shared-owned-native-sidebar-leak --strict --no-interactive`
- [x] 6.4 [P0] 实机：Shared 里 `3+3` Grok → `1=1` Qoder Global（可再加 PI）。侧栏只留 Shared；冷启不得先闪崽再藏（2026-08-22 用户确认正确）
- [x] 6.5 [P1] 命中 ADR「Shared sidebar hide / spawn 闸」触发器；收口回写基石「零、当前实现校准」
