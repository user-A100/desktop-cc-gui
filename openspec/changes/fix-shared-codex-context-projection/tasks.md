## 1. Context delivery capability

- [x] 1.1 [P0] Make Shared Codex Context capability select portable transcript/checkpoint and omit tool history. Verify with focused Rust tests for the capability and compiled package.

## 2. Retry classification

- [x] 2.1 [P0] Classify the missing-reasoning invalid request as permanent and add Vitest coverage proving it does not retry while existing transient errors do.

## 3. Verification

- [x] 3.1 [P0] Run focused Rust/Vitest tests, strict OpenSpec validation, and diff-scope checks. Verify no pre-existing dirty hunk was changed.
