## ADDED Requirements

### Requirement: Qoder Model Selector MUST Expose The Bound Distribution

The Composer model selector MUST render Qoder Global/CN as distribution channels
under the Qoder engine, not as separate engines or ordinary provider CRUD entries.
Its refresh and settings actions MUST target the selected distribution only.

#### Scenario: CN picker refresh

- **WHEN** the current Qoder execution target is CN and the user refreshes models
- **THEN** the selector MUST request only the CN catalog scope
- **AND** its configuration action MUST open the Qoder CN card

#### Scenario: Qoder channel change chooses a valid model

- **WHEN** the user changes a Qoder target from Global to CN
- **THEN** the selector MUST load or use a CN catalog before persisting the target
- **AND** it MUST NOT carry a Global-only model id into the CN target

#### Scenario: Qoder is available in a Shared Session

- **WHEN** Qoder is ready and the current thread is a Shared Session
- **THEN** the Composer MUST use Qoder's actual availability status
- **AND** it MUST NOT render a stale “not available in Shared Session” override
