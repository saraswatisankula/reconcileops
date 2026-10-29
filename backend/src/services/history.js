import { ident } from '../db.js';

// Every environment schema carries its own history table, similar to
// Flyway's flyway_schema_history. It is the "what the database says" side
// of reconciliation, while migration_runs in the metadata DB is the
// "what the pipeline says" side.
export const HISTORY_TABLE = 'rops_schema_history';

export async function ensureEnvSchema(client, schema) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${ident(schema)}.${HISTORY_TABLE} (
       version      INT PRIMARY KEY,
       description  TEXT NOT NULL,
       checksum     CHAR(64) NOT NULL,
       phase        TEXT NOT NULL,
       applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
       execution_ms INT NOT NULL
     )`
  );
}

export async function readHistory(db, schema) {
  const exists = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, HISTORY_TABLE]
  );
  if (!exists.rowCount) return [];
  const r = await db.query(
    `SELECT version, description, checksum, phase, applied_at, execution_ms
       FROM ${ident(schema)}.${HISTORY_TABLE} ORDER BY version`
  );
  return r.rows;
}

export async function recordApplied(client, schema, script, ms) {
  await client.query(
    `INSERT INTO ${ident(schema)}.${HISTORY_TABLE} (version, description, checksum, phase, execution_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [script.version, script.description, script.checksum, script.phase, ms]
  );
}

export async function removeApplied(client, schema, version) {
  await client.query(`DELETE FROM ${ident(schema)}.${HISTORY_TABLE} WHERE version = $1`, [version]);
}
