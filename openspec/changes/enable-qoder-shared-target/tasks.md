# enable-qoder-shared-target tasks

> 前置：Shared 语境 Spike 已完成（spike §14，probe6/7/10/11）。本 tasks 只做 F 层 wiring + 测试 + 验收。
> 纪律：F1 双集合必须同 PR 同步；⚠ 项（F1/F2/F3/F4/F5 全部）无编译/测试兜底，逐处人工核对。

## Phase 0 — OpenSpec + Spike（已完成）

- [x] 0.1 Shared 语境补采：probe10（跨进程 resume 回忆）/ probe11（`session/list` probe + `--config-dir` 隔离）
- [x] 0.2 spike §14 落档 + 后置记录 §2 更新
- [x] 0.3 创建 `openspec/changes/enable-qoder-shared-target/`（proposal / design / tasks / spec delta）
- [x] 0.4 `openspec validate enable-qoder-shared-target --strict --no-interactive` 通过

## Phase 1 — F 层 wiring（单 PR，前后端同集合）

- [x] 1.1 F1a：`sharedSessionEngines.ts` union + Set 加 `"qoder"`；normalize 注释更新
- [x] 1.2 F1b：`shared_sessions.rs` `is_supported_shared_session_engine()` 加 `Qoder`
- [x] 1.3 F2：`shared_session_v2.rs` `context_capabilities()` Qoder 臂 + `provider_runtime_key_for_target()` / provisioning / 发送 / interrupt 补臂 + `validate_execution_target` runtime-only 目录放行；canonical validator engine 枚举加 qoder
- [x] 1.4 F3：`shared_runtime_coordinator.rs` Qoder 移入 `engine:{raw}` 前缀臂
- [x] 1.5 F4：`shared_projection/commands.rs` `is_legacy_local_provider` Qoder 臂
- [x] 1.6 F5：`shared_sessions.rs` pending / established 双臂改真实判断
- [x] 1.7 人工 diff 前后端双集合一致；tsc 牵出的附加 wiring 一并完成（design §3 F8–F12：control owner union / sentinel / picker 目录 / 侧栏菜单）

## Phase 2 — 测试

- [x] 2.1 `sharedSessionEngines.test.ts` 三条 qoder 反例改正例（另：`types.atomic` / `useProviderTargetCatalogOwners` / `ChatInputBoxAdapter` / `useSidebarMenus` / `resolveDefaultCreationExecutionTarget` 旧契约断言同步翻转）
- [x] 2.2 Shared negative-path：qoder 加入 `shared_interrupt_route_isolates_same_engine_provider_owners`；ACK 不确定 → `recovery-required` / cancel race / 迟到 chunk 幂等为引擎无关通用路径，存量套件覆盖（267+1 全绿）
- [x] 2.3 基石 §14.3.5 Contract Test Suite qoder 覆盖：引擎参数化用例全部带上 qoder（`provider_engine_events_settle_exact_shared_attempts` #1/#4/#12、`newly_supported_shared_engines_use_weak_user_channel_context` #7、`newly_supported_engine_receipts_accept_local_and_managed_identity`、interrupt route 隔离 #6/#10）；新增 `qoder_shared_runtime_key_matches_native_ownership` / `qoder_runtime_only_catalog_passes_target_validation`；#9/#11/#13/#14 为引擎无关 durable 路径由存量套件覆盖
- [x] 2.4 存量回归：matrix gate / 前端 1719 项 / Rust shared 套件全绿（3 项预存失败与 qoder 无关：codex 目录漂移 2 项、DSH app-shell bridge 欠账 1 项，均已实证 HEAD 可复现）
- [x] 2.5 F15：`sharedHideIdentity.ts` 将 `qoder` 加入现有 `SHARED_HIDE_ENGINE_PREFIXES`。canonical `qoder:<profile>:<raw>` **不**展开 bare/raw alias（防 Global/CN 撞 raw）；仅历史 `qoder:<raw>` / raw 保留 Global-compatible alias。独立 Qoder Native parent 不受影响。live 认主/早画闸已由归档 change `fix-shared-owned-native-sidebar-leak` 接线。
- [x] 2.6 F16：复用既有 V2 read-only binding identity 查询，供 daemon 的 `list_shared_sessions` / 无 `SharedEventWriter` catalog projection 按 Shared session 恢复 V2-only owner；补 V0 `bindings_by_target`，不得依赖 title，读失败只 fallback V0；覆盖 Qoder current / archived identity 的 owner 隔离回归与 RPC route 存在性。
- [x] 2.7 F17：Qoder Native / Shared durable identity 升级为 `qoder:<providerProfileId>:<rawSessionId>`；补 Global/CN same-raw 隔离、legacy metadata migration、history / send / receipt / interrupt owner 与 canonical-hide 回归。

## Phase 3 — 验收与校准回写

- [ ] 3.1 真实 Shared 会话目视：按 `verification.md` A–F 勾选（picker / Global·CN / 侧栏不漏崽 / 幕布四件套 / Stop 隔离）
- [x] 3.2 基石设计「零、当前实现校准」Shared target boundary 行 + 「最近校准」回写（ADR 校准 Gate；含 canonical fact engine 枚举事实源）
- [ ] 3.3 后置记录 §2 Shared 行标记收口
- [ ] 3.4 `add-qoder-engine` 归档时同步修订其 Shared 排除 delta（或确认本 change 后归档覆盖）
