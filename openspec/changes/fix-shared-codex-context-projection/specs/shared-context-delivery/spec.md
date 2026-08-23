## ADDED Requirements

### Requirement: Codex Structured Context Import MUST Require Protocol-Safe Capability Evidence

Codex Shared Context delivery MUST NOT use `thread/inject_items` merely because the JSON-RPC method exists. Method availability alone is insufficient evidence that the destination provider accepts reconstructed assistant, reasoning, and tool-item dependencies.

#### Scenario: method-only Codex capability uses portable delivery

- **WHEN** a Codex app-server reports `thread/inject_items` but no protocol-safe item-chain evidence exists
- **THEN** Shared Context delivery MUST use prompt-prefix transcript/checkpoint delivery
- **AND** it MUST NOT record `thread/inject_items-jsonrpc-success` as Context acceptance evidence
