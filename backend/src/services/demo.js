import { demo as demoPool, envSchema, ident, meta, one, q } from '../db.js';
import { checksum } from '../utils/sql.js';
import { audit } from './audit.js';
import { DEMO_PROJECTS } from './demoData.js';
import { executeScript } from './executor.js';
import { validateAndStore } from './validation.js';

const ENV_NAMES = ['development', 'staging', 'production'];

export async function resetDemo(actor = 'operator') {
  for (const p of DEMO_PROJECTS) {
    for (const env of ENV_NAMES) {
      await demoPool.query(`DROP SCHEMA IF EXISTS ${ident(envSchema(p.slug, env))} CASCADE`);
    }
  }

  const client = await meta.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM projects WHERE slug = ANY($1)', [DEMO_PROJECTS.map((p) => p.slug)]);
    for (const p of DEMO_PROJECTS) {
      const { rows: [proj] } = await client.query(
        `INSERT INTO projects (name, slug, description, primary_table) VALUES ($1, $2, $3, $4) RETURNING id`,
        [p.name, p.slug, p.description, p.primary_table]
      );
      for (const app of p.apps) {
        await insertApp(client, proj.id, app.version, app.requires);
      }
      for (const s of p.scripts) {
        await client.query(
          `INSERT INTO migration_scripts (project_id, version, description, phase, up_sql, down_sql, checksum)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [proj.id, s.version, s.description, s.phase, s.up, s.down, checksum(s.up, s.down)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await audit('demo.reset', 'demo', null, { projects: DEMO_PROJECTS.map((p) => p.slug) }, actor);
  return { ok: true };
}

async function insertApp(client, projectId, version, requires) {
  const { rows: [app] } = await client.query(
    `INSERT INTO app_versions (project_id, version) VALUES ($1, $2) RETURNING id`,
    [projectId, version]
  );
  for (const [table, cols] of Object.entries(requires)) {
    for (const c of cols) {
      await client.query(
        `INSERT INTO app_requirements (app_version_id, table_name, column_name) VALUES ($1, $2, $3)`,
        [app.id, table, c]
      );
    }
  }
}

async function project(slug) {
  const p = await one('SELECT * FROM projects WHERE slug = $1', [slug]);
  if (!p) throw new Error('Demo data not found. Run "Reset demo data" first.');
  return p;
}

async function scriptOf(slug, version) {
  const p = await project(slug);
  return one('SELECT * FROM migration_scripts WHERE project_id = $1 AND version = $2', [p.id, version]);
}

async function validate(slug, version, dryRunEnv) {
  const s = await scriptOf(slug, version);
  const r = await validateAndStore(s.id, { dryRunEnv, actor: 'demo' });
  return { label: `Validate ${slug} V${version}`, ok: r.passed, detail: `${r.errors} error(s), ${r.warnings} warning(s)`, issues: r.issues };
}

async function run(slug, version, env) {
  const s = await scriptOf(slug, version);
  try {
    const r = await executeScript({
      scriptId: s.id, environment: env, actor: 'demo', acknowledgeWarnings: true, confirm: slug,
    });
    const run = r.run;
    return {
      label: `Run ${slug} V${version} on ${env}`,
      ok: run.status === 'success' && !run.needs_manual,
      status: run.status,
      runId: run.id,
      detail: run.error_message || `${run.duration_ms} ms, ${run.probe_failed}/${run.probe_total} probe reads impacted`,
    };
  } catch (err) {
    return { label: `Run ${slug} V${version} on ${env}`, ok: false, status: 'blocked', detail: err.details?.reasons?.join(' ') || err.message };
  }
}

async function setAppActive(slug, version, active) {
  const p = await project(slug);
  await q('UPDATE app_versions SET active = $3 WHERE project_id = $1 AND version = $2', [p.id, version, active]);
  await audit(active ? 'app.activated' : 'app.retired', 'project', p.id, { version }, 'demo');
  return { label: `${active ? 'Activate' : 'Retire'} ${slug} app ${version}`, ok: true, detail: 'Compatibility requirements updated' };
}

// Each step does real work through the same services the UI uses.
export const DEMO_STEPS = [
  {
    key: 'product-baseline', group: 'Product Service', title: 'Baseline: create products in every environment',
    explain: 'Validates V1, then promotes it development -> staging -> production.',
    expect: 'success',
    run: async () => [
      await validate('product_service', 1, 'development'),
      await run('product_service', 1, 'development'),
      await run('product_service', 1, 'staging'),
      await run('product_service', 1, 'production'),
    ],
  },
  {
    key: 'product-expand', group: 'Product Service', title: 'Expand: add price_cents alongside price',
    explain: 'Additive change with a sync trigger. Probes keep reading with app v1.0 while it runs.',
    expect: 'success',
    run: async () => [
      await validate('product_service', 2, 'development'),
      await run('product_service', 2, 'development'),
      await run('product_service', 2, 'staging'),
      await run('product_service', 2, 'production'),
    ],
  },
  {
    key: 'product-app-v2', group: 'Product Service', title: 'Deploy app v2.0 that reads price_cents',
    explain: 'Registers a new app version and its column requirements. v1.0 is still running.',
    expect: 'success',
    run: async () => {
      const p = await project('product_service');
      const exists = await one('SELECT id FROM app_versions WHERE project_id = $1 AND version = $2', [p.id, 'v2.0']);
      if (!exists) {
        const c = await meta.connect();
        try {
          await insertApp(c, p.id, 'v2.0', { products: ['id', 'sku', 'name', 'price_cents'] });
        } finally {
          c.release();
        }
        await audit('app.registered', 'project', p.id, { version: 'v2.0' }, 'demo');
      }
      return [{ label: 'Register app v2.0', ok: true, detail: 'v2.0 requires products(id, sku, name, price_cents)' }];
    },
  },
  {
    key: 'product-migrate', group: 'Product Service', title: 'Migrate: make price_cents NOT NULL',
    explain: 'Uses NOT VALID + VALIDATE to keep lock time short.',
    expect: 'success',
    run: async () => [
      await validate('product_service', 3, 'development'),
      await run('product_service', 3, 'development'),
    ],
  },
  {
    key: 'product-incompatible', group: 'Product Service', title: 'Incompatible: direct column rename',
    explain: 'V4 renames name -> title in one step. Both app versions read "name".',
    expect: 'rejected',
    run: async () => [await validate('product_service', 4)],
  },
  {
    key: 'product-contract-early', group: 'Product Service', title: 'Contract too early',
    explain: 'V5 drops price while app v1.0 is still active. Validation must refuse it.',
    expect: 'rejected',
    run: async () => [await validate('product_service', 5)],
  },
  {
    key: 'product-contract', group: 'Product Service', title: 'Retire v1.0, then contract',
    explain: 'Once no running app reads price, V5 becomes safe.',
    expect: 'success',
    run: async () => [
      await setAppActive('product_service', 'v1.0', false),
      await validate('product_service', 5, 'development'),
      await run('product_service', 5, 'development'),
    ],
  },
  {
    key: 'order-baseline', group: 'Order Service', title: 'Baseline + concurrent index',
    explain: 'V1 creates orders. V2 builds an index CONCURRENTLY outside a transaction.',
    expect: 'success',
    run: async () => [
      await validate('order_service', 1, 'development'),
      await run('order_service', 1, 'development'),
      await validate('order_service', 2, 'development'),
      await run('order_service', 2, 'development'),
    ],
  },
  {
    key: 'order-failed', group: 'Order Service', title: 'Failed migration (bad data)',
    explain: 'V3 adds CHECK (quantity > 0) but a legacy row has quantity 0. Execution fails, the transaction rolls back.',
    expect: 'failed',
    run: async () => [
      await validate('order_service', 3),
      await run('order_service', 3, 'development'),
    ],
  },
  {
    key: 'order-recover', group: 'Order Service', title: 'Recover: retire V3, fix data in V4',
    explain: 'The failed script is marked rejected and a corrected version is applied.',
    expect: 'success',
    run: async () => {
      const s = await scriptOf('order_service', 3);
      await q(`UPDATE migration_scripts SET status = 'rejected', updated_at = now() WHERE id = $1`, [s.id]);
      await audit('script.rejected', 'script', s.id, { version: 3, reason: 'superseded by V4' }, 'demo');
      return [
        { label: 'Mark V3 rejected', ok: true, detail: 'Superseded by V4' },
        await validate('order_service', 4, 'development'),
        await run('order_service', 4, 'development'),
      ];
    },
  },
  {
    key: 'order-health-rollback', group: 'Order Service', title: 'Health check triggers rollback',
    explain: 'V5 hides a rename inside a DO block. It runs, the v1.0 probe fails, and the down script restores the schema.',
    expect: 'rolled_back',
    run: async () => [
      await validate('order_service', 5),
      await run('order_service', 5, 'development'),
    ],
  },
  {
    key: 'drift-create', group: 'Reconciliation', title: 'Simulate a manual hotfix (drift)',
    explain: 'Someone adds a column directly in development, bypassing the pipeline.',
    expect: 'drift',
    run: async () => {
      const schema = envSchema('product_service', 'development');
      await project('product_service');
      await demoPool.query(`ALTER TABLE ${ident(schema)}.products ADD COLUMN IF NOT EXISTS hotfix_note TEXT`);
      await audit('demo.drift_created', 'demo', null, { schema }, 'demo');
      return [{ label: 'ALTER TABLE products ADD COLUMN hotfix_note', ok: true, detail: 'Open Reconcile for Product Service / development' }];
    },
  },
  {
    key: 'drift-revert', group: 'Reconciliation', title: 'Revert the manual hotfix',
    explain: 'Removes the out-of-band column so the environment is back in sync.',
    expect: 'success',
    run: async () => {
      const schema = envSchema('product_service', 'development');
      await demoPool.query(`ALTER TABLE ${ident(schema)}.products DROP COLUMN IF EXISTS hotfix_note`);
      await audit('demo.drift_reverted', 'demo', null, { schema }, 'demo');
      return [{ label: 'Drop hotfix_note', ok: true, detail: 'Drift removed' }];
    },
  },
];

export async function runDemoStep(key) {
  const step = DEMO_STEPS.find((s) => s.key === key);
  if (!step) return null;
  const results = await step.run();
  await audit('demo.step', 'demo', null, { key, results: results.map((r) => ({ label: r.label, ok: r.ok })) }, 'demo');
  return { key, title: step.title, expect: step.expect, results };
}
