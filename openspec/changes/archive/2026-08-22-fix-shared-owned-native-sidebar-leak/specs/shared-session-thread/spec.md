## ADDED Requirements

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
