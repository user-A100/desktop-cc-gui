# shared-session-thread Specification

## Purpose

Defines the shared-session-thread behavior contract, covering Shared Session Is A Distinct Immutable Conversation Type.

## Requirements
### Requirement: Shared Session Is A Distinct Immutable Conversation Type

The system MUST allow users to create a `shared session` as a distinct conversation type alongside native `Codex`, `Claude`, `Gemini`, and `OpenCode` sessions, and MUST preserve that type after creation.

#### Scenario: user creates a shared session from new conversation flow

- **WHEN** the user creates a new conversation and chooses `shared session`
- **THEN** the system MUST create a conversation whose persisted type is `shared`
- **AND** conversation list, tabs, and reopen flows MUST recognize it as `shared` rather than as a native engine session

#### Scenario: shared session type remains fixed after creation

- **WHEN** the user reopens, renames, or continues an existing `shared session`
- **THEN** the system MUST preserve the `shared` conversation type
- **AND** the system MUST NOT silently convert that conversation into any native engine session type

### Requirement: Shared Session Maintains One Canonical Thread

A `shared session` MUST append all user turns and assistant outputs into one canonical shared thread even when the selected execution engine changes between turns.

#### Scenario: switching engine between turns keeps one shared history

- **WHEN** the user sends one turn with `Claude` and a later turn with `Codex` inside the same `shared session`
- **THEN** both turns MUST appear in one continuous shared conversation history
- **AND** the system MUST NOT create a second primary user-facing conversation just because the execution engine changed

#### Scenario: shared session identity stays stable across navigation surfaces

- **WHEN** the user leaves the active conversation and later returns through conversation list, topbar tab, or reopen flow
- **THEN** the system MUST resolve the same `shared session` identity
- **AND** the recovered conversation history MUST remain attached to that same shared thread

### Requirement: Shared Session Hidden Native Bindings Stay Internal

Native bindings owned by a `shared session` are runtime internals and MUST NOT become user-facing native conversations. This rule applies to every Shared-supported engine (`Claude`, `Codex`, `Kimi`, `Grok`, `OpenCode`, `PI`, and `Qoder`), not only `Claude` / `Codex`.

Ownership MUST include:

- 当前 durable binding id
- Shared 续跑新写的 native 文件 sessionId（Claude `{fileUuid}.jsonl` 与信封 `binding:` 不必相同）
- 首条真实 user 为 MOSSX 协议包的 session，即使预览标题已被抽成用户原话

#### Scenario: selector change does not create a visible native conversation

- **WHEN** the user switches selected engine inside a `shared session` but has not sent a new turn
- **THEN** the system MUST persist the shared selector state for that session
- **AND** the system MUST NOT create an extra user-visible native conversation only because of that selector change

#### Scenario: shared-owned native bindings are filtered from native list surfaces

- **WHEN** thread list / tabs / reopen flows include both native sessions and shared sessions
- **THEN** native bindings marked as shared-owned internals MUST remain hidden from native conversation surfaces for Claude, Codex, Kimi, Grok, OpenCode, PI, and Qoder
- **AND** users MUST continue the conversation through the `shared session` identity

#### Scenario: grok shared binding does not appear as native sidebar row

- **WHEN** a Shared Session turn executes on Grok and materializes a Hidden Native Binding
- **THEN** the thread list MUST NOT show a separate Grok native row for that binding
  (including sessions whose first message is a context-package marker)
- **AND** the only user-facing conversation row for that work MUST remain the `shared:*` identity

#### Scenario: kimi and opencode shared bindings stay hidden after real id finalizes

- **WHEN** a Shared Session turn executes on Kimi or OpenCode and the runtime later finalizes a real native session id
- **THEN** the durable binding MUST be updated to that real identity
- **AND** subsequent thread list / catalog merges MUST hide that native id from user-facing native surfaces

#### Scenario: claude continuation file ids stay hidden from sidebar

- **WHEN** Shared 续跑为同一 `session:{sharedId}` 新写 `{fileUuid}.jsonl`，信封 binding 仍为旧 id
- **AND** 首条 user 为 `MOSSX_SHARED_CONTEXT_V1`，预览标题为「继续」
- **THEN** 侧栏 MUST NOT 展示 `claude:{fileUuid}` 为用户 native 会话
- **AND** hide set MUST 能以 `{fileUuid}` 命中其子代理 parent

### Requirement: Shared Live Pending Claim Uses Execution Target

`thread/started` 与等价的 pending rebind 生产路径 MUST 用 `engine + providerProfileId`（Execution Target）认 pending Shared binding。系统 MUST NOT 在生产路径调用 `resolvePendingSharedSessionBindingForEngine` 作为 Qoder / Grok / PI / Claude 双 provider 的认主公式。

Qoder Target MUST 显式携带 `__qoder_global__` 或 `__qoder_cn__`。`null` / `__local_qoder__` 只允许作为历史 Global 兼容输入。同 workspace 内同一 engine 多条 pending MUST 按 Target 分开认主，MUST NOT fail-closed 成 `null` 后再走 Native `ensureThread`。

认回 Shared 之后，该事件 MUST 停止 Native 开行（不得再调用 `onThreadStarted` / `onThreadSessionIdUpdated` 把该 native id 画进侧栏）。

#### Scenario: two pending Grok Shared sessions in one workspace stay isolated

- **WHEN** the same workspace has two Shared sessions whose Grok bindings are both still pending
- **AND** a `thread/started` event arrives for one Grok native session
- **THEN** the system MUST claim only the matching Shared Target
- **AND** the system MUST NOT open a user-facing Grok native sidebar row
- **AND** the other Shared session MUST keep its own pending binding

#### Scenario: Qoder Global and CN pending bindings do not cross-claim

- **WHEN** one Shared session is pending Qoder Global (`__qoder_global__`) and another is pending Qoder CN (`__qoder_cn__`) in the same workspace
- **AND** ACP reports a raw sessionId that could exist in both distributions
- **THEN** `thread/started` MUST claim using the event's `providerProfileId`
- **AND** Global MUST finalize as `qoder:__qoder_global__:<raw>`
- **AND** CN MUST finalize as `qoder:__qoder_cn__:<raw>`
- **AND** neither distribution MUST be written as `qoder:<raw>`
- **AND** neither Native row MUST appear in the sidebar

#### Scenario: engine-only pending resolver is not used on the live path

- **WHEN** a Shared-supported engine other than a single-owner Claude/Codex default emits `thread/started` while a pending Shared binding exists
- **THEN** the production handler MUST resolve that binding by Target
- **AND** it MUST NOT call `resolvePendingSharedSessionBindingForEngine` as the authority
- **AND** a Target miss MUST leave the pending binding untouched rather than spawning a user-facing Native conversation

### Requirement: Shared-Owned Native Must Not Enter Sidebar Via Live Ensure

`ensureThread` / `onThreadStarted` MUST treat Shared-owned native ids as internals even when `parentThreadId` does not start with `shared:`.

A native id MUST be excluded from the user-facing sidebar when any of the following is true:

- it intersects the current hide set / last-verified hide set
- it is a `{engine}-pending-shared-*` placeholder
- it is already registered as a Shared binding nativeThreadId（含 identity keys 互认）

用户主动创建、且不在上述集合中的 Native 会话 MUST 保持可见。

#### Scenario: Grok thread/started without shared parent still stays hidden

- **WHEN** Shared sends a Grok turn and the runtime emits `thread/started` without `parent` starting with `shared:`
- **AND** a pending or established Shared Grok binding exists for that Target
- **THEN** the Grok native id MUST NOT be inserted as a sidebar root or child row
- **AND** the user-facing conversation MUST remain the `shared:*` row

#### Scenario: Qoder jsonl scan cannot outrun live claim

- **WHEN** Qoder writes `~/.qoder/projects/<cwd>/*.jsonl` and Session Index imports it as `qoder:__qoder_global__:<raw>` titled from the first user prompt
- **AND** that session is the Shared-owned binding for the current turn
- **THEN** the Index row MUST NOT appear as a sidebar Native conversation
- **AND** a later cold-start hide catch-up MUST NOT be required for correctness

#### Scenario: user-created Native sessions remain visible

- **WHEN** the user creates a Grok or Qoder Native session that is not a Shared binding
- **THEN** that session MUST remain visible in the sidebar
- **AND** Shared hide / live claim MUST NOT hide it because of engine prefix alone

### Requirement: Pending To Canonical Promotion Enters Hide Immediately

Pending Shared binding 晋升到 canonical native id 之后，hide set MUST 立刻包含 canonical identity keys。系统 MUST NOT 等到下一次 `listSharedSessions` 或 post-first-paint Index soft re-sync 才开始隐藏该行。

Qoder canonical hide MUST 只含 `qoder:<profile>:<raw>`；MUST NOT 把 canonical 展开成 `qoder:<raw>` / raw alias。历史 `qoder:<raw>` 仅作为 Global 兼容输入展开。Grok / PI 的 lookup MUST 走 identity keys，不得只做精确字符串匹配。

#### Scenario: Shared serial Grok then Qoder then PI leaves only the shared row

- **WHEN** the user sends `3+3` to Grok, then `1=1` to Qoder Global, then a PI turn, all inside one Shared session
- **THEN** the sidebar MUST show only that `shared:*` row for this work
- **AND** it MUST NOT show a Grok native titled `3+3`
- **AND** it MUST NOT show a Qoder Global native titled from that prompt, nor hang that Qoder row under the Grok native

#### Scenario: canonical hide covers the Index scan row before idle resync

- **WHEN** a Qoder Global binding is promoted from `qoder-pending-shared-*` to `qoder:__qoder_global__:<raw>`
- **AND** Session Index already has that canonical row
- **THEN** hide identity MUST intersect the Index row immediately
- **AND** the row MUST NOT remain visible until the quiet Index soft re-sync (~800ms–8s)

#### Scenario: PI and Qoder async disk refresh rebuild hide set

- **WHEN** an asynchronous PI or Qoder native session refresh is in flight
- **AND** a Shared binding materializes before that refresh merges
- **THEN** the refresh MUST rebuild hide set from a current Shared list unioned with the outer hide set
- **AND** it MUST NOT merge the Shared-owned native row using the empty hide set captured at list start

### Requirement: Shared Session Folder Assignment Stays Separate From Native Assignment

`shared session` folder organization MUST target the canonical `shared:*` thread identity and MUST NOT reuse native engine folder assignment for its hidden bindings.

#### Scenario: native folder assignment rejects shared thread ids

- **WHEN** a caller attempts to move a `shared:*` thread through native session folder assignment
- **THEN** the native assignment path MUST reject the request instead of treating it as a `Claude` or `Codex` native session
- **AND** the system MUST preserve the existing shared session folder/root placement

#### Scenario: hidden native bindings do not define shared folder placement

- **WHEN** a `shared session` has hidden `Claude` or `Codex` native bindings
- **THEN** moving or projecting those hidden bindings MUST NOT be considered the durable folder assignment for the shared session
- **AND** users MUST continue to see the shared conversation through the canonical `shared:*` identity

#### Scenario: empty shared sessions may remain at root until shared assignment exists

- **WHEN** a newly created `shared session` has no completed turn yet
- **AND** no shared-specific folder assignment contract is available
- **THEN** the system MAY keep that empty shared session at project root
- **AND** later conversation activity MAY allow existing projection refresh logic to place it under the intended folder as a best-effort behavior

### Requirement: Shared Session History Rendering Preserves User Turns

Shared history replay MUST preserve user-message visibility even when source payloads are wrapper/fallback formats.

#### Scenario: wrapped user payload still renders one visible user bubble

- **WHEN** shared history contains user messages wrapped by context-sync or fallback prefixes
- **THEN** the replayed conversation MUST show a visible user bubble with the effective current request text
- **AND** the system MUST NOT drop that user bubble during history load or reopen

#### Scenario: optimistic reconcile does not truncate unmatched earlier user history

- **WHEN** local optimistic user bubbles coexist with delayed shared snapshot reconciliation
- **THEN** unmatched earlier optimistic user entries MUST be preserved until a deterministic match arrives
- **AND** the system MUST NOT truncate prior user history because of a broad fallback replace

### Requirement: Shared Pending Rebinding Is Safe And Deterministic

Pending placeholder rebind for shared/native bridge MUST avoid stale or ambiguous mappings, and MUST cover every Shared-supported engine that can finalize a native session id after send.

#### Scenario: pending rebind uses unique fresh placeholder

- **WHEN** runtime events arrive for a shared turn whose native thread id finalized after send
- **THEN** the bridge MUST rebind through a unique pending placeholder for the same workspace/engine
- **AND** subsequent turn events MUST route to the same shared thread identity

#### Scenario: pending rebind covers all shared engines

- **WHEN** a Shared Session pending binding exists for Claude, Codex, Kimi, Grok, or OpenCode
- **AND** a `thread/started` (or equivalent identity finalization) event arrives for that engine
- **THEN** the bridge MUST be allowed to rebind that engine's pending placeholder to the finalized native thread id
- **AND** the system MUST NOT limit this rebind path to Claude/Codex only

#### Scenario: stale or ambiguous pending placeholders are ignored

- **WHEN** multiple pending placeholders exist or the pending placeholder is stale
- **THEN** the bridge MUST reject fallback rebind for that event
- **AND** the system MUST avoid assigning that event to an unrelated shared conversation

### Requirement: Shared Session Recovery Preserves Engine Provenance

The system MUST preserve source-engine metadata for assistant messages and key activity facts inside a `shared session` so history remains explainable after replay and reopen.

#### Scenario: shared history retains source engine metadata

- **WHEN** a `shared session` contains assistant turns or key activity facts produced by different engines
- **THEN** persisted history MUST retain engine provenance for each relevant record
- **AND** replay consumers MUST be able to determine which engine produced that record

#### Scenario: reopen restores one shared conversation with provenance intact

- **WHEN** the user closes and later reopens an existing `shared session`
- **THEN** the system MUST restore one shared conversation history with source-engine metadata intact
- **AND** the system MUST NOT split that recovered history into multiple unrelated native engine conversations

### Requirement: Native Engine Sessions Remain Unchanged

Adding `shared session` support MUST NOT change the creation, reopen, or history semantics of existing native engine sessions.

#### Scenario: native session flow remains engine-scoped

- **WHEN** the user creates or reopens a native `Codex`, `Claude`, `Gemini`, or `OpenCode` conversation
- **THEN** the existing conversation MUST remain engine-scoped and follow its current native lifecycle
- **AND** the presence of `shared session` support MUST NOT force migration or conversion

### Requirement: Shared History Recovery MUST Remain Owned By The Shared Thread

Shared history reload MUST use the stable canonical `shared:<UUID>` identity independently from its
display title. A successful empty canonical projection MUST be treated as a valid empty Shared
Session. A projection failure MUST remain observable and retryable, and MUST NOT activate or expose
the Native history recovery card or Native automatic-recovery block.

#### Scenario: title changes after first user turn

- **WHEN** Shared Session presentation metadata changes from `Shared Session` to the first user
  message
- **THEN** Sidebar and history loading MUST continue using the original `shared:<UUID>`
- **AND** all canonical history MUST remain attached to that same Shared thread

#### Scenario: new Shared Session has no canonical turns

- **WHEN** a newly created Shared Session successfully loads an empty canonical projection
- **THEN** the history load MUST complete as a valid empty state
- **AND** the UI MUST NOT show the Native “current session needs recovery” card

#### Scenario: Shared projection temporarily fails

- **WHEN** canonical projection fails and no readable Legacy snapshot exists
- **THEN** the failure MUST remain observable in diagnostics
- **AND** selecting the Shared Session again MUST retry canonical loading
- **AND** the UI MUST NOT show the Native history recovery card
- **AND** the loader MUST NOT invoke a Native Codex or Claude history fallback

#### Scenario: Native history recovery remains unchanged

- **WHEN** a Native Session enters its existing history recovery failure state
- **THEN** the Native recovery card and action MUST remain available
- **AND** Shared-specific recovery rules MUST NOT alter that Native state
