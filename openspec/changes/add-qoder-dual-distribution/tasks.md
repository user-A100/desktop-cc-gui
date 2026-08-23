## 1. Distribution domain and persistence

- [x] 1.1 Add stable Qoder Global/CN distribution ids, labels and compatibility normalization in frontend and Rust; verify legacy empty / `__local_qoder__` resolves to Global.
- [x] 1.2 Extend app settings and daemon payload mapping with CN binary and per-distribution config roots; preserve `qoderBin` as Global compatibility and add focused normalization tests.
- [x] 1.3 Refactor Qoder credential storage/status into a distribution-aware API; retain existing Global PAT file and isolate CN PAT storage and environment injection.

## 2. Rust runtime, catalog, and history isolation

- [x] 2.1 Introduce one Qoder distribution launch resolver for binary, config environment, PAT environment, home/history root and runtime key; unit-test Global/CN and legacy paths.
- [x] 2.2 Route Qoder ACP process spawn, manager ownership, send, fork and interrupt through the resolved distribution descriptor; verify no Global fallback occurs for CN.
- [x] 2.3 Make Qoder status, doctor and `get_engine_models` provider-profile/distribution-aware; return diagnostic empty/error states without cross-distribution catalogs.
- [x] 2.4 Thread distribution through Qoder list/load/delete history commands and catalog projections; preserve Global legacy history and isolate CN disk/ACP fallback.

## 3. Client interaction and configuration

- [x] 3.1 Teach Qoder provider-profile constants, target catalog owners and model selector normalization that Global/CN are persisted distribution bindings, not null local sentinels.
- [x] 3.2 Scope Qoder model catalog request/cache/last-good rows to distribution and assert sidebar session switching issues no catalog IPC.
- [x] 3.3 Change the sidebar New Session Qoder item to a parent with Global/CN children; pass binding metadata through thread creation and add focused menu tests.
- [x] 3.4 Replace the single Qoder settings/auth surface with independent Global/CN configuration cards and distribution-targeted login/PAT actions; add component/service tests.
- [x] 3.5 Replace stacked Global/CN settings cards with a single Qoder-local `Global / CN` Tab panel: default Global, CN deep link selects CN, transition honors `prefers-reduced-motion`, and no runtime/catalog path changes.

## 4. Verification and closure

- [x] 4.1 Run focused TypeScript and Rust tests for Qoder runtime, catalog, sidebar and settings; fix regressions.
- [x] 4.2 Run relevant typecheck/lint/contract gates and `openspec validate add-qoder-dual-distribution --strict --no-interactive`; record any unrelated baseline failures.
- [x] 4.3 Perform a separate reviewer pass against proposal/specs/design, update this task list with evidence, and leave the worktree uncommitted for user review.

## 验证记录

- Focused Vitest：13 files / 396 tests passed，覆盖 sidebar、model selector、catalog、settings/auth、history binding，以及 Qoder CN 的 pending/rebind interrupt binding。
- `cargo test qoder --lib --quiet`：59 passed；`cargo check --quiet` passed。
- `tsc --noEmit` passed；Qoder 受影响前端文件 ESLint 为 0 errors。`useThreadMessaging.ts` 保留 1 条未触及的 DSH hook warning。
- `npm run check:engine-capability-matrix`（15 capabilities）与 `npm run check:model-provider-catalog` passed。
- `npm run check:app-shell:governance`：22 passed；`openspec validate add-qoder-dual-distribution --strict --no-interactive` 与 `git diff --check` passed。
- `npm run lint` 仍有 9 个既有 errors / 34 warnings，errors 位于 `usePromptEnhancer.test.tsx`、`DebugPanel.tsx`、`AgentInspectorDrawer.tsx`、`personaAssign.ts`、`WorktreePrompt.tsx`；本变更未新增 error。
- 独立 reviewer 对照 D1–D5 后修复了 home-prefix config root、daemon settings 同步、Qoder CN selector settings deep link、以及 Native / pending Qoder CN interrupt 丢失 binding 四处边界；并确认没有新增 `qoder-cn` engine id、跨 distribution catalog fallback 或 PAT 参数泄露。
- 审计修复（2026-08-22）：Shared Qoder 新建已显式绑定 Global/CN；再将未知 distribution profile 的校验下沉至 Tx1 core，确保不会写入 `conversation.turnRequested` 或 Binding。独立 review 还清除了 Composer 的过期“Shared 不支持 Qoder”状态覆盖。`cargo test shared_session_v2 --lib --quiet`（47）、`cargo test qoder --lib --quiet`（63）、`cargo test shared_binding_visibility --lib --quiet`（2）、Focused Vitest（5 files / 103）、`cargo check --quiet`、`tsc --noEmit`、`check:engine-capability-matrix`、`check:model-provider-catalog` 与 strict OpenSpec validation 均通过。
- Qoder Tab calibration：`VendorSettingsPanel.test.tsx` 36/36、`pnpm typecheck` 与 strict OpenSpec validation 通过；测试保留既有 `CliLifecycleProvider` 的 `act(...)` warning，未新增失败。
