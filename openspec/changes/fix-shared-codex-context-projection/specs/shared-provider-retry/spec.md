## ADDED Requirements

### Requirement: Deterministic Context Protocol Failures MUST Not Retry The Same Binding

Shared provider retry MUST fail closed when an `invalid_request_error` states that a message is missing its required reasoning item. The error represents an incomplete provider-native Context chain rather than a transient provider failure.

#### Scenario: missing reasoning item stops automatic retry

- **WHEN** a Shared terminal error contains `required reasoning item`
- **THEN** the retry classifier MUST mark it permanent
- **AND** it MUST NOT schedule another attempt on the same CLI / Provider / Model Binding
