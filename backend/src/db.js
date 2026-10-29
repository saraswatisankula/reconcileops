import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// Two completely separate pools. The metadata DB holds ReconcileOps' own data,
// the demo DB is the "target" that migrations are executed against.
export const meta = new pg.Pool({ connectionString: config.META_DATABASE_URL, max: 10 });
export const demo = new pg.Pool({ connectionString: config.DEMO_DATABASE_URL, max: 10 });

meta.on('error', (err) => logger.error({ err }, 'metadata pool error'));
demo.on('error', (err) => logger.error({ err }, 'demo pool error'));

export async function q(text, params) {
  const res = await meta.query(text, params);
  return res.rows;
}

export async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function closePools() {
  await Promise.allSettled([meta.end(), demo.end()]);
}

// Each project + environment gets its own schema inside the demo database,
// e.g. product_service_staging. Names are built only from validated slugs.
export function envSchema(projectSlug, envName) {
  const name = `${projectSlug}_${envName}`;
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(name)) {
    throw new Error(`Unsafe schema name: ${name}`);
  }
  return name;
}

export function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
