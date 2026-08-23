## ADDED Requirements

### Requirement: Qoder Distribution Binding MUST Be Persisted Per Session

For `qoder`, the system MUST treat `__qoder_global__` and `__qoder_cn__` as
persistable distribution bindings rather than generic local provider sentinels.
Creation, canonical identity promotion, fork and continuation MUST retain the
resolved distribution. Global settings edits MUST NOT reroute a bound Qoder thread.

#### Scenario: parallel Global and CN Qoder sessions

- **WHEN** one workspace has a Global Qoder thread and a CN Qoder thread
- **THEN** both threads MUST retain different persisted bindings
- **AND** their sends MUST use different distribution runtime keys and launch
  descriptors

#### Scenario: legacy local sentinel compatibility

- **WHEN** a legacy Qoder thread contains `__local_qoder__` or no profile id
- **THEN** it MUST use the Global compatibility binding
- **AND** a newly created Global thread MUST use the explicit Global distribution
  binding instead of being normalized to `null`

#### Scenario: unknown Qoder distribution is rejected before Shared Tx1

- **WHEN** a Shared Qoder target contains a non-empty profile id other than
  `__local_qoder__`, `__qoder_global__`, or `__qoder_cn__`
- **THEN** the system MUST return `target-unavailable` before writing
  `conversation.turnRequested` or a binding row
- **AND** it MUST NOT silently fall back to the Global distribution
