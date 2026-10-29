# Architecture

## The short version

ReconcileOps is a control panel for database schema changes. You write migration
scripts for a service, it checks them, runs them against a database, watches whether
the service can still read its data while that happens, and rolls back if something
breaks afterwards.

```mermaid
flowchart LR
    subgraph Browser
        UI[React + Vite UI<br/>Recharts, React Router]
    end

    subgraph Backend[Node.js / Express API]
        R[REST routes<br/>zod validation, token auth,<br/>rate limit, helmet]
        V[Validator<br/>static SQL rules]
        DR[Dry run<br/>execute + ROLLBACK]
        X[Executor<br/>locks, retries, timeouts]
        P[Read probe<br/>measures impact]
        H[Health checks]
        REC[Reconciliation engine]
        M[Metrics + CSV]
        A[Audit log]
    end

    subgraph MetaDB[(PostgreSQL: metadata)]
        T1[projects, scripts,<br/>app versions, runs,<br/>health, audit, settings]
    end

    subgraph DemoDB[(PostgreSQL: demo target)]
        S1[product_service_development]
        S2[product_service_staging]
        S3[product_service_production]
        S4[order_service_*]
    end

    FW[Flyway] -->|V1__metadata_schema.sql| MetaDB
    UI -->|/api| R
    R --> V & DR & X & REC & H & M
    X --> P
    X --> H
    V & X & REC & H & M & A --> MetaDB
    DR & X & P & H & REC --> DemoDB
```

## Why two databases

The **metadata database** stores what ReconcileOps knows: services, scripts, app
versions, runs, health results and the audit log. Flyway manages its schema
(`backend/db/migrations`).

The **demo database** is the thing being migrated. It is a separate PostgreSQL
server in Docker Compose. If a demo migration goes wrong, ReconcileOps' own data is
untouched. The app refuses to start if both URLs point to the same database.

Inside the demo database, every service + environment pair gets its own schema:
`product_service_development`, `product_service_staging`, `product_service_production`.
This stands in for three separate environments. It is cheaper than running nine
databases, but it does share one server, so it is a simulation of isolation rather
than true infrastructure isolation (see Limitations in the README).

## What happens when you click "Run"

```mermaid
sequenceDiagram
    participant U as Operator
    participant API as Executor
    participant Meta as Metadata DB
    participant Demo as Demo DB
    participant Probe as Read probe

    U->>API: execute V3 on staging
    API->>Meta: pre-flight (validated? warnings acknowledged?<br/>earlier versions applied? passed development?)
    API->>Meta: INSERT run (status=running)<br/>unique index blocks a second running run
    API->>Demo: pg_try_advisory_lock(schema)
    API->>Probe: start SELECTs that live app versions use
    loop up to max_retries
        API->>Demo: BEGIN; SET LOCAL search_path, lock_timeout, statement_timeout
        API->>Demo: up script + history row
        alt ok
            API->>Demo: COMMIT
        else lock timeout / deadlock
            API->>Demo: ROLLBACK, wait, retry
        else other error
            API->>Demo: ROLLBACK (schema unchanged), stop
        end
    end
    API->>Probe: stop, collect failed/slow reads
    API->>Demo: health checks
    alt checks fail and down script exists and auto-rollback on
        API->>Demo: run down script, delete history row
        API->>Meta: status=rolled_back, rollback_ms
    else checks fail, no down script
        API->>Meta: needs_manual=true
    end
    API->>Meta: audit entry
```

Scripts that contain `CREATE INDEX CONCURRENTLY` cannot run inside a transaction.
The validator requires them to be the only statement in their script, and the executor
runs them without `BEGIN`. If one fails, the run is marked for manual review because
PostgreSQL can leave an invalid index behind. The `index_validity` health check
reports it.

## The reconciliation engine

`backend/src/services/reconcile.js` compares four sources of truth for one
service + environment:

| Source | Where it comes from |
|---|---|
| Desired schema | All validated scripts replayed in a throwaway schema inside a transaction that is rolled back |
| Actual schema | `information_schema` and `pg_catalog` for the environment schema |
| Migration history | The environment's `rops_schema_history` table and successful `migration_runs` |
| Compatibility requirements | Columns that active app versions read (`app_requirements`) |

It reports:

* **drift**: the real schema differs from what the applied history says it should be (for example a manual hotfix),
* **history problems**: an applied script was edited (checksum mismatch), a version is in the database but not the pipeline or the other way round, out-of-order versions,
* **compatibility problems**: a live app needs a column that is missing now or would be removed by the desired state,
* **a plan**: the validated scripts still to apply, in order.

Any error-level finding blocks the plan. "Apply plan" runs the scripts one at a time
through the normal executor and stops at the first problem.

## Zero-downtime approach: expand and contract

The demo walks through the standard pattern for changing a column without stopping
the service:

1. **Expand** (V2): add `price_cents` next to `price`, backfill it, and add a trigger so
   old and new app versions both write correct data.
2. **Deploy app v2.0**, which reads `price_cents`. v1.0 is still running.
3. **Migrate** (V3): tighten `price_cents` using `NOT VALID` + `VALIDATE CONSTRAINT`
   to keep lock time short.
4. **Contract** (V5): drop `price`. The validator refuses this while any active app
   version still reads `price`. Retiring v1.0 unlocks it.

The probe measures whether reads were actually affected. It does not prove
zero downtime in general. A fast migration on a five-row table finishes before any
read is slowed down. The integration test `retries after a lock timeout and measures
blocked reads` shows the opposite case: another session holds a lock, the migration
retries, and the probe records the blocked reads.

## Research paper vs this implementation

Your upload contained the abstract and project brief, but **not** the EvolveDB
paper itself (Eckwert et al., 2025), so nothing here is taken from its text. The
comparison below is based on the paper's title and the general model-driven schema
evolution approach it names. Check it against the paper before using it in a report.

| Model-driven schema evolution (research concept) | ReconcileOps (this project) |
|---|---|
| The schema is described as a model; changes are model operations | The schema is described by ordered SQL migration scripts (Flyway-style versions) |
| Migrations are derived from differences between model versions | Scripts are written by hand; the tool derives the *desired schema* by replaying them and diffs it against reality |
| Focus on correctness of evolution and data migration at design time | Focus on operations: validation, safe execution, measured impact, health checks, rollback, audit |
| Usually a single database lifecycle | Three environments with promotion order, per-service ownership |

Ideas that belong to your abstract rather than the paper: treating schemas as
version-controlled artefacts in a CI/CD pipeline, backward-compatibility checks
against running app versions, post-deployment health checks with automatic rollback,
and the evaluation metrics (success rate, downtime, rollback time, compatibility
issues, manual interventions). ReconcileOps implements all of these.

## Code map

```
backend/
  db/migrations/V1__metadata_schema.sql   Flyway migration for the metadata DB
  src/app.js, server.js                   Express setup, startup clean-up of stale runs
  src/routes/projects.js                  services, scripts, app versions, compare, reconcile, health
  src/routes/misc.js                      dashboard, runs, metrics, CSV, audit, settings, demo
  src/services/validator.js               static SQL rules (pure function, unit tested)
  src/services/validation.js              stores results, dry run
  src/services/executor.js                execution, retries, rollback, pre-flight rules
  src/services/probe.js                   read probe during execution
  src/services/health.js                  post-deploy checks
  src/services/reconcile.js               reconciliation engine
  src/services/desired.js                 desired schema by replay + rollback
  src/services/introspect.js, schemaDiff.js
  src/services/demo.js, demoData.js       Product / Order demo
frontend/src/
  pages/        one file per screen
  components/   shared UI, charts, project tabs
e2e/            Playwright browser tests
```
