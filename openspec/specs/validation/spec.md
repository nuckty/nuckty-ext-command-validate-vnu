# validation Specification

## Purpose
TBD - created by archiving change allow-validation-port. Update Purpose after archive.

## Requirements

### Requirement: Validation port
The validate command SHALL accept --port with an integer from 1 through 65535, default to 8888 and reject invalid values before starting Java.

#### Scenario: Requested behavior
- **WHEN** a caller chooses a free port
- **THEN** validation and cleanup use that port without touching services on the default port
