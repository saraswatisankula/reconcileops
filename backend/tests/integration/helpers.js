import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demo, meta as metaDb } from '../../src/db.js';

export const enabled = Boolean(process.env.TEST_META_DATABASE_URL && process.env.TEST_DEMO_DATABASE_URL);

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(here, '..', '..', 'db', 'migrations');

// CI runs Flyway first. Locally we apply the same files if the tables are missing.
export async function ensureMetaSchema() {
  const r = await metaDb.query(`SELECT to_regclass('public.projects') AS t`);
  if (r.rows[0].t) return;
  for (const f of fs.readdirSync(migrations).filter((x) => /^V\d+__.*\.sql$/.test(x)).sort()) {
    await metaDb.query(fs.readFileSync(path.join(migrations, f), 'utf8'));
  }
}

export async function resetAll() {
  await ensureMetaSchema();
  await metaDb.query(`TRUNCATE projects, audit_logs RESTART IDENTITY CASCADE`);
  await metaDb.query(`UPDATE settings SET value = CASE key
      WHEN 'auto_rollback' THEN 'true'::jsonb
      WHEN 'max_retries' THEN '2'::jsonb
      WHEN 'retry_backoff_ms' THEN '400'::jsonb
      WHEN 'lock_timeout_ms' THEN '3000'::jsonb
      WHEN 'statement_timeout_ms' THEN '30000'::jsonb
      WHEN 'probe_interval_ms' THEN '50'::jsonb
      WHEN 'enforce_promotion_order' THEN 'true'::jsonb
      ELSE value END`);
  await metaDb.query(`UPDATE environments SET protected = (name = 'production')`);
  const schemas = await demo.query(
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('public', 'information_schema') AND nspname NOT LIKE 'pg\\_%'`
  );
  for (const s of schemas.rows) await demo.query(`DROP SCHEMA "${s.nspname}" CASCADE`);
}
