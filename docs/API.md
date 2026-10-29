# REST API

Base URL: `http://localhost:4000/api` (or `/api` through the frontend).
All bodies are JSON. Errors look like `{ "error": "message", "reasons"?: [...], "details"?: [...] }`.

**Auth.** If `API_TOKEN` is set on the server, every non-GET request needs
`Authorization: Bearer <token>`. An optional `X-Actor: <name>` header is recorded in the audit log.

**Status codes.** 400 bad input, 401 bad token, 404 not found, 409 conflict (duplicate,
concurrent run, immutable script), 422 refused by a safety rule (with `reasons`), 503 database unreachable.

## Health and system

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness. Pings both databases. |
| GET | `/system` | Masked connection info, server versions, whether auth is on. |
| GET | `/dashboard` | Metrics, promotion track grid, latest audit entries. |

## Services (projects)

| Method | Path | Body / query |
|---|---|---|
| GET | `/projects` | List with script counts and last run. |
| POST | `/projects` | `{ name, slug, description?, primary_table? }`. Slug: `^[a-z][a-z0-9_]{1,38}$`. |
| GET | `/projects/:id` | Service + per-environment version, history and last health. |
| PUT | `/projects/:id` | `{ name, description?, primary_table? }` |
| DELETE | `/projects/:id?confirm=<slug>` | Refused while a run is in progress. |

## Migration scripts

| Method | Path | Body / query |
|---|---|---|
| GET | `/projects/:id/scripts` | Includes last validation and `applied_in`. |
| POST | `/projects/:id/scripts` | `{ version, description, phase, up_sql, down_sql? }`. Saved as `draft`. |
| GET | `/projects/:id/scripts/:sid` | Script + last 10 validations. |
| PUT | `/projects/:id/scripts/:sid` | Same body. 409 if applied anywhere. Resets status to `draft`. |
| PATCH | `/projects/:id/scripts/:sid/status` | `{ status: "draft" \| "rejected" }` |
| DELETE | `/projects/:id/scripts/:sid` | 409 if it has any run history. |
| POST | `/projects/:id/scripts/:sid/validate` | `{ dryRunEnvironment?: "development" \| "staging" \| "production" }` |
| GET | `/projects/:id/scripts/:sid/preflight?environment=` | `{ ok, reasons[], needsConfirm, warnings }` |
| POST | `/projects/:id/scripts/:sid/execute` | `{ environment, acknowledgeWarnings?, confirm? }`. `confirm` must equal the slug for protected environments. |

Validation response:

```json
{
  "passed": false, "errors": 1, "warnings": 0, "statementCount": 1, "nonTransactional": false,
  "issues": [{ "rule": "rename-column", "severity": "error",
    "message": "Renaming \"products.name\" breaks app v1.0, v2.0",
    "statement": "ALTER TABLE products RENAME COLUMN name TO title",
    "suggestion": "Expand: add the new column and backfill. Contract: drop the old one later." }],
  "dryRun": null
}
```

Execute response: `{ run, health, healthBeforeRollback? }` where `run` contains
`status, attempts, duration_ms, probe_total, probe_failed, downtime_ms, rollback_ms, needs_manual, error_message, error_code, log[]`.

## App versions (compatibility requirements)

| Method | Path | Body |
|---|---|---|
| GET | `/projects/:id/apps` | Versions with `requirements: [{table, column}]`. |
| POST | `/projects/:id/apps` | `{ version, requirements: [{ table, column }] }` |
| PATCH | `/projects/:id/apps/:aid` | `{ active: boolean }`. Retire or reactivate. |
| DELETE | `/projects/:id/apps/:aid` | |

## Schema, comparison, reconciliation, health

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/schema?environment=` | Introspected tables, columns, indexes, constraints. |
| GET | `/projects/:id/compare?left=&right=` | Each side is `desired` or an environment. Returns both schemas and `differences[]`. |
| GET | `/projects/:id/reconcile?environment=` | `{ state: in_sync \| pending \| drift \| blocked, currentVersion, targetVersion, plan[], findings[], changes[], sources }` |
| POST | `/projects/:id/reconcile/apply` | `{ environment, acknowledgeWarnings?, confirm? }`. Applies the plan in order, stops on first problem. |
| GET | `/projects/:id/health` | Last 200 health check rows. |
| POST | `/projects/:id/health/run` | `{ environment }` |

## Runs

| Method | Path | Notes |
|---|---|---|
| GET | `/runs?projectId=&environment=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD` | Latest 200. |
| GET | `/runs/:id` | Run with log and its health checks. |
| POST | `/runs/:id/rollback` | `{ confirm? }`. Only the newest applied version, only with a down script. |
| POST | `/runs/:id/retry` | `{ acknowledgeWarnings?, confirm? }`. For failed, blocked or rolled-back runs. |

## Metrics and reports

| Method | Path | Notes |
|---|---|---|
| GET | `/metrics?…same filters as /runs` | `{ summary, daily[], recent[], byEnv[], issues[] }` |
| GET | `/reports/runs.csv?…filters` | CSV download. Cells starting with `= + - @` are prefixed to prevent formula injection. |

## Audit, settings, environments

| Method | Path | Notes |
|---|---|---|
| GET | `/audit?action=&entity=&limit=` | `action` is a prefix match, e.g. `migration`. |
| GET / PUT | `/settings` | `auto_rollback, max_retries (0-5), retry_backoff_ms, lock_timeout_ms, statement_timeout_ms, probe_interval_ms, enforce_promotion_order` |
| GET | `/environments` | |
| PATCH | `/environments/:id` | `{ description?, protected? }` |

## Demo

| Method | Path | Notes |
|---|---|---|
| GET | `/demo/steps` | Step list. |
| POST | `/demo/reset` | Drops demo schemas, recreates Product and Order services. |
| POST | `/demo/steps/:key` | Runs one step through the normal services and returns the real results. |

## Example session with curl

```bash
curl -X POST localhost:4000/api/demo/reset
curl -X POST localhost:4000/api/demo/steps/product-baseline
curl "localhost:4000/api/projects/1/reconcile?environment=staging"
curl -o runs.csv localhost:4000/api/reports/runs.csv
```
