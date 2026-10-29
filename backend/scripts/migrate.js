// Applies the metadata DB migrations in db/migrations.
// With Docker Compose, the official Flyway container does this instead.
// This script uses the Flyway CLI if it is installed, otherwise it applies the
// same V<n>__name.sql files itself (useful on machines without Flyway/Docker).
import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const url = process.env.META_DATABASE_URL;
if (!url) {
  console.error('META_DATABASE_URL is not set');
  process.exit(1);
}

const hasFlyway = spawnSync('flyway', ['-v'], { stdio: 'ignore' }).status === 0;

if (hasFlyway && !process.env.SKIP_FLYWAY_CLI) {
  const u = new URL(url);
  execFileSync('flyway', [
    `-url=jdbc:postgresql://${u.hostname}:${u.port || 5432}${u.pathname}`,
    `-user=${decodeURIComponent(u.username)}`,
    `-password=${decodeURIComponent(u.password)}`,
    `-locations=filesystem:${dir}`,
    'migrate',
  ], { stdio: 'inherit' });
  process.exit(0);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS rops_meta_migrations (
  version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
const done = new Set((await client.query('SELECT version FROM rops_meta_migrations')).rows.map((r) => r.version));

const files = fs.readdirSync(dir)
  .map((f) => ({ f, m: f.match(/^V(\d+)__(.+)\.sql$/) }))
  .filter((x) => x.m)
  .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));

for (const { f, m } of files) {
  const v = Number(m[1]);
  if (done.has(v)) continue;
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO rops_meta_migrations (version, name) VALUES ($1, $2)', [v, m[2]]);
    await client.query('COMMIT');
    console.log(`applied ${f}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`failed ${f}: ${err.message}`);
    process.exit(1);
  }
}
console.log('metadata database is up to date');
await client.end();
