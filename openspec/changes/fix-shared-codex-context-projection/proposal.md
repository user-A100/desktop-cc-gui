## Why

Shared Codex currently treats `thread/inject_items` availability as proof that a destination accepts a complete Responses item chain. Third-party compatible providers can instead reject a later turn when the injected assistant/tool history lacks its provider-private `reasoning` item. The failed Shared attempt is deterministic, so retrying the same Binding repeats the failure.

## 目标与边界

- Shared Codex cross-Binding delivery must use portable text context, not Responses structured history injection.
- Tool Call/Result history must be omitted atomically from that portable delivery.
- The exact missing-reasoning protocol failure must not enter automatic same-Binding retry.
- Keep existing transcript budget, checkpoint compression, original-task preservation, and normal transient provider retry behavior.

## 非目标

- Do not change Native Codex provider continuation.
- Do not change non-Codex Shared engines or their Context capability matrix.
- Do not retry every no-status error.
- Do not repair already-polluted native Codex threads in place.

## What Changes

- Disable `structured_history_import`, `tool_history`, and strong Context ACK for Shared Codex targets; select the existing portable transcript path.
- Extend the Shared retry classifier with the exact `required reasoning item` invalid-request signature as a permanent context-protocol failure.
- Keep tool-call/result omission visible through the existing projection manifest rather than serializing partial Responses items.

## Capabilities

### New Capabilities

- `shared-provider-retry`: deterministic Shared provider protocol failures are classified separately from transient retries.

### Modified Capabilities

- `shared-context-compiler`: Codex Shared cross-Binding projection omits provider-native tool exchanges and uses portable transcript delivery.
- `shared-context-delivery`: Codex Shared Context acceptance must not claim structured import merely from `thread/inject_items` method availability.

## 技术方案

1. **推荐：Codex Shared 一律走 portable transcript。** 复用已有 compiler 与 budget/omission 机制，完整避开跨 provider Responses item compatibility 风险。
2. **仅关闭 tool history，保留 structured import。** 改动小，但 assistant message 仍可能依赖私有 reasoning，不能消除截图错误。
3. **探测并维护 provider-specific item-schema capability。** 理论上可保留官方 structured import，但没有无副作用的 schema probe，且需要额外持久化与降级状态；超出本次范围。

选择方案 1：最小、可回滚，并按现有 portable allowlist 传递可移植语义。

## 验收标准

- Codex Shared capability 不再启用 `thread/inject_items` Context delivery。
- Codex Shared package 不含 `atomic-tool-exchange`，而普通 user/assistant 文本仍可传递。
- `required reasoning item` 报错显示为不可自动重试；429/timeout 等既有暂态错误仍保持 retryable。
- 定向 Rust 与 Vitest 测试通过，且无本次范围外文件变化。

## Impact

- `src-tauri/src/shared_session_v2.rs`：Shared Codex Context capability 与 Rust tests。
- `src/features/shared-session/provider-retry/classifySharedProviderRetryError.ts`：错误分类与 Vitest。
- Existing Shared Context/retry OpenSpec capability deltas.
