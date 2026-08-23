## MODIFIED Requirements

### Requirement: Thread-list ingest prefilters use Shared hide identity

侧栏 `listThreads` orchestrator 在把 native session **写入 merge map 之前**的 Shared hide 预过滤 MUST 与 Shared hide identity 使用同一判定：`threadIdInHiddenSharedBindingSet`（即 `sharedHideIdentityIntersects`）。

预过滤 MUST 覆盖以下 ingest 入口：

- live Codex `listThreads` 行
- live Claude / OpenCode 行
- project catalog session 行
- OpenCode / DSH continuity 保留行
- Gemini / Kimi / Grok / Pi / DSH / Qoder cache 与异步 refresh 预过滤
- Session Index first-paint / early-paint 行

系统 MUST NOT 在上述入口使用 exact `Set.has(literalId)` 作为 Shared hide 判定。
系统 MUST NOT 使用 first-colon / last-colon / `indexOf(":")` 剥离来匹配 hide set。
系统 MUST NOT 发明未观测到的 Codex rollout 时间戳。
系统 MUST NOT 回退 empty-hide fail-closed（那会蒸发 Windows Grok 等真 Native）。

hide 未就绪（Shared visibility 非 `verified`，且本进程尚无 last-verified hide）时：

- 系统 MUST 保留 last-good 中仍在范围内、且不是已知 Shared-owned 的 native 行
- 系统 MUST NOT full-show 本轮 Index 新出现、且不在 last-verified hide 里的 `grok` / `pi` / `qoder` native 行
- 这些新行 MUST 等到 `listSharedSessions`（或等价 durable hide 源）返回后再决定去留
- last-good MUST NOT 把上一轮泄漏的 Shared-owned native 做成权威

Candidate id MUST 是该行进入侧栏后的 id：

- Codex：live `entry.id` 或 catalog `sessionId` 的字面值
- Qoder：canonical `qoder:<providerProfileId>:<sessionId>`；历史 `qoder:<sessionId>` 只作 Global 兼容
- 其它引擎：`engine:sessionId` 或已存在的 `thread.id`

Windows 盘符 / UNC / extended path 与 POSIX 绝对路径 MUST NOT 被预过滤误藏，也 MUST NOT 被当成 engine 前缀剥离。

#### Scenario: live Codex rollout stem is dropped before merge

- **WHEN** hide set 仅由 `{uuid}` 或 `codex:{uuid}` expand 而来（集合内无 `rollout-` 键）
- **AND** live Codex 行 id 为 `rollout-YYYY-MM-DDTHH-MM-SS-{uuid}`
- **THEN** ingest 预过滤 MUST 丢弃该行
- **AND** 该行 MUST NOT 进入 merge map

#### Scenario: catalog sessionId stem uses identity not first-colon

- **WHEN** catalog `sessionId` 为 `rollout-YYYY-MM-DDTHH-MM-SS-{uuid}` 或 `codex:rollout-YYYY-MM-DDTHH-MM-SS-{uuid}`
- **AND** hide set 仅有 `{uuid}` / `codex:{uuid}`
- **THEN** catalog 预过滤 MUST 丢弃该 session
- **AND** 实现 MUST NOT 用 `indexOf(":")` 计算 hide 命中

#### Scenario: prefixed engine rows use the sidebar id as candidate

- **WHEN** Claude / OpenCode / Kimi / Grok / Pi / Gemini / DSH / Qoder 预过滤面对 `engine:{sessionId}` 或 Qoder canonical 行
- **AND** hide set 经 expand 含该行 identity（含 raw / `engine:raw` / Codex uuid 变体 / Qoder canonical）
- **THEN** 预过滤 MUST 丢弃该行
- **AND** Gemini / DSH MUST 传入带前缀 candidate，不得只传 bare sessionId

#### Scenario: continuity keep-path respects identity hide

- **WHEN** OpenCode 或 DSH continuity 准备保留已有 `thread.id`
- **AND** 该 id 与 hide set identity 相交
- **THEN** 系统 MUST NOT 把该行重新写入 merge map

#### Scenario: filesystem path ids are not colon-hidden

- **WHEN** candidate 为 `S:\AIWorker\proj`、`\\?\C:\…`、UNC、`/Users/…` 或 `/home/…`
- **AND** hide set 不含该路径字面值，也不含与其相交的 identity
- **THEN** 预过滤 MUST NOT 丢弃该行
- **AND** MUST NOT 把盘符或 POSIX 路径当成 engine 前缀剥离后再查 hide set

#### Scenario: hide unreadiness keeps last-good but does not full-show new Shared-engine natives

- **WHEN** Shared visibility 未就绪
- **AND** Session Index first-paint 返回了新的 `grok` / `pi` / `qoder` native 行
- **AND** those ids are not in last-verified hide
- **THEN** 系统 MUST NOT 把这些新行作为权威 native 写入侧栏
- **AND** 系统 MUST 保留 last-good 中仍在范围内的非 Shared-owned native
- **AND** 系统 MUST NOT 因本预过滤改回 empty-hide fail-closed

#### Scenario: last-good must not promote a leaked Shared-owned native

- **WHEN** a previous in-session snapshot leaked a Shared-owned Grok or Qoder native row into last-good
- **AND** a later list has a usable hide set that intersects that id
- **THEN** the leaked row MUST be stripped
- **AND** last-good continuity MUST NOT resurrect it as an authoritative native conversation
