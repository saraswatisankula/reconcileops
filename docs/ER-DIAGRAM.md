# Metadata database: ER diagram

Defined in `backend/db/migrations/V1__metadata_schema.sql` and applied by Flyway.

```mermaid
erDiagram
    projects ||--o{ migration_scripts : owns
    projects ||--o{ app_versions : deploys
    app_versions ||--o{ app_requirements : reads
    migration_scripts ||--o{ validation_results : checked_by
    projects ||--o{ migration_runs : has
    environments ||--o{ migration_runs : targets
    migration_scripts ||--o{ migration_runs : executed_as
    migration_runs ||--o{ health_checks : verified_by
    projects ||--o{ health_checks : has
    environments ||--o{ health_checks : in

    environments {
        serial id PK
        varchar name UK "development | staging | production"
        smallint stage_order UK "promotion order"
        boolean protected "needs typed confirmation"
    }
    projects {
        serial id PK
        varchar name
        varchar slug UK "used in schema names"
        varchar primary_table
    }
    migration_scripts {
        serial id PK
        int project_id FK
        int version "UNIQUE with project_id"
        varchar phase "standard | expand | migrate | contract"
        text up_sql
        text down_sql "nullable: not every change is reversible"
        char checksum "sha-256 of up + down"
        varchar status "draft | validated | rejected"
    }
    app_versions {
        serial id PK
        int project_id FK
        varchar version
        boolean active "retired versions no longer protect columns"
    }
    app_requirements {
        serial id PK
        int app_version_id FK
        varchar table_name
        varchar column_name
    }
    validation_results {
        serial id PK
        int script_id FK
        boolean passed
        int error_count
        int warning_count
        jsonb issues
        jsonb dry_run
    }
    migration_runs {
        serial id PK
        int project_id FK
        int environment_id FK
        int script_id FK
        varchar status "running | success | failed | rolled_back | blocked"
        int attempts
        int duration_ms
        int probe_total
        int probe_failed
        int downtime_ms "measured read impact"
        int rollback_ms
        boolean needs_manual
        varchar error_code "SQLSTATE"
        jsonb log
    }
    health_checks {
        serial id PK
        int project_id FK
        int environment_id FK
        int run_id FK "null for manual checks"
        varchar check_name
        boolean passed
        text details
    }
    audit_logs {
        bigserial id PK
        varchar actor
        varchar action
        varchar entity
        int entity_id
        jsonb details
    }
    settings {
        varchar key PK
        jsonb value
    }
```

## Constraints that do real work

| Constraint | Purpose |
|---|---|
| `uq_one_running_run` (partial unique index on `project_id, environment_id WHERE status='running'`) | Only one migration can run per service and environment at a time. A second request gets 409. |
| `uq_script_success_once` (partial unique on `script_id, environment_id WHERE status='success'`) | A script cannot succeed twice in the same environment. |
| `UNIQUE (project_id, version)` | Version numbers can't repeat within a service. |
| `CHECK` on `status`, `phase`, `slug` | The database rejects invalid states even if the API had a bug. |
| `ON DELETE CASCADE` from projects | Deleting a service removes its scripts, runs and health history together. |

## Per-environment history table (demo database)

Each environment schema also has `rops_schema_history`
(`version PK, description, checksum, phase, applied_at, execution_ms`). It is written in
the same transaction as the migration, so it can't disagree with the actual schema
change. The reconciliation engine compares it with `migration_runs`.
