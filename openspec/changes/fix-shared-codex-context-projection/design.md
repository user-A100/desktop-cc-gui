## Context

Codex Shared currently enables structured import when the app-server exposes `thread/inject_items`. That method-level probe does not prove that a provider accepts partially reconstructed Responses history. Canonical Shared context does not retain provider-private reasoning items, while the current projection may inject assistant and tool items that depend on them.

## Goals / Non-Goals

**Goals:** use the existing portable transcript route for Codex Shared cross-Binding delivery, omit tool exchanges atomically, and fail closed on the exact missing-reasoning error.

**Non-Goals:** Native Codex continuation, compatibility probing, repair of an already-created contaminated native thread, or broad retry changes.

## Decisions

1. Codex Shared reports no structured import capability. The compiler therefore selects `portable-transcript` or its existing bounded checkpoint fallback, and records tool exchange omissions through its manifest.
2. The retry classifier treats `invalid_request_error` containing `required reasoning item` as permanent `config` failure. Retrying the same Binding cannot supply the missing item.
3. Do not add a new recovery path in this patch. New Shared bindings are safe; an existing contaminated binding remains user-recoverable through the existing session recovery/target actions.

Alternative rejected: omit only `function_call` items. The failing provider contract also links assistant messages to private reasoning, so this does not establish protocol closure.

## Risks / Trade-offs

- [More prompt text than structured import] → Existing compiler budget/checkpoint bounds output.
- [Less tool detail after target switch] → Tool exchanges are provider-native and intentionally omitted as an atomic pair; assistant/user semantic text remains.
- [Existing polluted thread stays polluted] → Avoid risky in-place history mutation; new deliveries do not add further malformed items.

## Migration Plan

1. Ship capability and classifier change.
2. New Codex Shared bindings use portable delivery immediately.
3. Rollback restores the single capability branch and classifier case; no storage migration exists.

## Open Questions

- None for this precise repair.
