## ADDED Requirements

### Requirement: Qoder Catalog Requests MUST Be Distribution-Isolated And Cold-Path Only

Qoder model catalog cache, request dedupe and last-good state MUST include the
distribution profile id. The application MUST request Qoder catalog data only when
the picker is opened, the user explicitly refreshes, or a send cannot proceed
without a catalog. Session switching and sidebar selection MUST NOT initiate a Qoder
catalog IPC.

#### Scenario: rapid session switching causes no Qoder catalog fetch

- **WHEN** the user switches between Qoder Global/CN history rows in the sidebar
- **THEN** the application MUST update selection identity and chrome only
- **AND** it MUST NOT call `get_engine_models` or modify the active distribution

#### Scenario: stale Global response cannot overwrite CN

- **WHEN** a Global catalog request resolves after a newer CN catalog request
- **THEN** the CN-visible picker MUST retain CN rows
- **AND** Global rows MAY update only the Global cache scope
