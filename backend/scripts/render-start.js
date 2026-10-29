// Start command for hosted deployments (Render, see render.yaml).
// Free hosting gives us a single PostgreSQL server, so this script:
//   1. derives DEMO_DATABASE_URL from META_DATABASE_URL (same server, separate
//      "reconcileops_demo" database) and creates that database if needed,
//   2. applies the metadata migrations (scripts/migrate.js),
//   3. starts the normal API server,
//   4. loads the demo walkthrough once if the metadata database is empty.
// Local development and Docker Compose don't use this file.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const metaUrl = process.env.META_DATABASE_URL;
if (!metaUrl) {
  console.error('META_DATABASE_URL is not set');
  process.exit(1);
}

if (!process.env.DEMO_DATABASE_URL) {
  const demoName = process.env.DEMO_DATABASE_NAME || 'reconcileops_demo';
  const u = new URL(metaUrl);
  u.pathname = `/${demoName}`;
  process.env.DEMO_DATABASE_URL = u.toString();

  const client = new pg.Client({ connectionString: metaUrl });
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [demoName]);
  if (!rowCount) {
    await client.query(`CREATE DATABASE "${demoName.replace(/"/g, '""')}"`);
    console.log(`created database ${demoName}`);
  }
  await client.end();
}

const migrate = spawnSync(process.execPath, [path.join(here, 'migrate.js')], {
  stdio: 'inherit',
  env: { ...process.env, SKIP_FLYWAY_CLI: '1' },
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

await import('../src/server.js');

if (process.env.AUTO_SEED_DEMO !== 'false') {
  seedDemoIfEmpty().catch((err) => console.error(`demo seed skipped: ${err.message}`));
}

async function seedDemoIfEmpty() {
  const base = `http://127.0.0.1:${process.env.PORT || 4000}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Actor': 'auto-seed' };
  if (process.env.API_TOKEN) headers.Authorization = `Bearer ${process.env.API_TOKEN}`;

  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const projects = await (await fetch(`${base}/projects`)).json();
  if (Array.isArray(projects) && projects.length) return;

  const post = async (p) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers, body: '{}' });
    if (!res.ok) throw new Error(`POST ${p} -> ${res.status}`);
  };
  await post('/demo/reset');
  const steps = await (await fetch(`${base}/demo/steps`)).json();
  for (const s of steps) await post(`/demo/steps/${s.key}`);
  console.log(`demo data loaded (${steps.length} steps)`);
}
