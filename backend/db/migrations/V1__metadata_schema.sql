-- ReconcileOps metadata database.
-- This database only stores information ABOUT migrations (projects, scripts,
-- runs, audit trail). The schemas being migrated live in a separate demo DB.

CREATE TABLE environments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(30)  NOT NULL UNIQUE,
    stage_order SMALLINT     NOT NULL UNIQUE CHECK (stage_order > 0),
    description TEXT,
    protected   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(80)  NOT NULL,
    slug        VARCHAR(40)  NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{1,38}$'),
    description TEXT,
    primary_table VARCHAR(63),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE migration_scripts (
    id          SERIAL PRIMARY KEY,
    project_id  INT          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version     INT          NOT NULL CHECK (version > 0),
    description VARCHAR(160) NOT NULL,
    phase       VARCHAR(10)  NOT NULL DEFAULT 'standard'
                CHECK (phase IN ('standard', 'expand', 'migrate', 'contract')),
    up_sql      TEXT         NOT NULL,
    down_sql    TEXT,
    checksum    CHAR(64)     NOT NULL,
    status      VARCHAR(12)  NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'validated', 'rejected')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
);

-- Which columns each deployed application version depends on.
-- Used for backward compatibility checks and post-deploy health probes.
CREATE TABLE app_versions (
    id          SERIAL PRIMARY KEY,
    project_id  INT          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version     VARCHAR(20)  NOT NULL,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
);

CREATE TABLE app_requirements (
    id             SERIAL PRIMARY KEY,
    app_version_id INT         NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
    table_name     VARCHAR(63) NOT NULL,
    column_name    VARCHAR(63) NOT NULL,
    UNIQUE (app_version_id, table_name, column_name)
);

CREATE TABLE validation_results (
    id          SERIAL PRIMARY KEY,
    script_id   INT          NOT NULL REFERENCES migration_scripts(id) ON DELETE CASCADE,
    passed      BOOLEAN      NOT NULL,
    error_count INT          NOT NULL DEFAULT 0,
    warning_count INT        NOT NULL DEFAULT 0,
    issues      JSONB        NOT NULL DEFAULT '[]',
    dry_run     JSONB,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE migration_runs (
    id            SERIAL PRIMARY KEY,
    project_id    INT          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id INT         NOT NULL REFERENCES environments(id),
    script_id     INT          NOT NULL REFERENCES migration_scripts(id) ON DELETE CASCADE,
    status        VARCHAR(12)  NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'success', 'failed', 'rolled_back', 'blocked')),
    attempts      INT          NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INT,
    probe_total   INT          NOT NULL DEFAULT 0,
    probe_failed  INT          NOT NULL DEFAULT 0,
    downtime_ms   INT          NOT NULL DEFAULT 0,
    rollback_ms   INT,
    needs_manual  BOOLEAN      NOT NULL DEFAULT FALSE,
    error_message TEXT,
    error_code    VARCHAR(10),
    triggered_by  VARCHAR(60)  NOT NULL DEFAULT 'operator',
    log           JSONB        NOT NULL DEFAULT '[]'
);

-- Concurrency guard: only one running migration per project + environment.
CREATE UNIQUE INDEX uq_one_running_run
    ON migration_runs (project_id, environment_id) WHERE status = 'running';

-- Duplicate guard: a script can succeed only once per environment.
CREATE UNIQUE INDEX uq_script_success_once
    ON migration_runs (script_id, environment_id) WHERE status = 'success';

CREATE INDEX idx_runs_started ON migration_runs (started_at DESC);

CREATE TABLE health_checks (
    id            SERIAL PRIMARY KEY,
    project_id    INT          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id INT         NOT NULL REFERENCES environments(id),
    run_id        INT          REFERENCES migration_runs(id) ON DELETE SET NULL,
    check_name    VARCHAR(60)  NOT NULL,
    passed        BOOLEAN      NOT NULL,
    details       TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_recent ON health_checks (project_id, environment_id, created_at DESC);

CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    actor       VARCHAR(60)  NOT NULL DEFAULT 'operator',
    action      VARCHAR(60)  NOT NULL,
    entity      VARCHAR(40)  NOT NULL,
    entity_id   INT,
    details     JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);

CREATE TABLE settings (
    key         VARCHAR(50)  PRIMARY KEY,
    value       JSONB        NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO environments (name, stage_order, description, protected) VALUES
    ('development', 1, 'Developer sandbox, migrations run freely', FALSE),
    ('staging',     2, 'Pre-production copy, must pass before prod', FALSE),
    ('production',  3, 'Protected, needs explicit confirmation', TRUE);

INSERT INTO settings (key, value) VALUES
    ('auto_rollback',            'true'),
    ('max_retries',              '2'),
    ('retry_backoff_ms',         '400'),
    ('lock_timeout_ms',          '3000'),
    ('statement_timeout_ms',     '30000'),
    ('probe_interval_ms',        '50'),
    ('enforce_promotion_order', 'true');
