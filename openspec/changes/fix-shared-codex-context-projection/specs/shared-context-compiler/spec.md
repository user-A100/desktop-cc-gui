## MODIFIED Requirements

### Requirement: Compiler MUST Select Projection Mode By Capability

The compiler MUST select the first applicable mode in this order: `native-delta`, `native-history-import`, `native-history-clone`, `portable-transcript`, `checkpoint`. Selection MUST use runtime capabilities and destination identity rather than engine-name branches. A Shared Codex target MUST NOT declare structured history import solely because its app-server exposes `thread/inject_items`.

#### Scenario: existing binding uses native delta

- **WHEN** destination binding identity is established and delta injection is supported
- **THEN** the compiler MUST select `native-delta`
- **AND** it MUST exclude entries natively owned by that binding

#### Scenario: structured import outranks transcript

- **WHEN** native delta is inapplicable and runtime capability reports structured history import
- **THEN** the compiler MUST select `native-history-import`
- **AND** it MUST NOT choose transcript merely because of engine type

#### Scenario: Codex Shared delivery avoids partial Responses item chains

- **WHEN** a Shared Codex target crosses into a Binding without native delta
- **THEN** the compiler MUST select `portable-transcript` or bounded `checkpoint`
- **AND** it MUST omit tool call/result exchanges as an atomic pair

#### Scenario: unsupported capability degrades explicitly

- **WHEN** import and clone are unsupported
- **THEN** the compiler MUST choose portable transcript if safe and within budget, otherwise checkpoint
- **AND** the Manifest MUST record the capability-driven reason
