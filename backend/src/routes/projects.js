import { Router } from 'express';
import { z } from 'zod';
import { demo, envSchema, meta, one, q } from '../db.js';
import { actor, validateBody } from '../middleware.js';
import { badRequest, conflict, notFound, wrap } from '../utils/errors.js';
import { checksum } from '../utils/sql.js';
import { audit } from '../services/audit.js';
import { getProject, getScript, listEnvironments, listScripts, getEnvironment } from '../services/projects.js';
import { introspect, schemaExists } from '../services/introspect.js';
import { readHistory } from '../services/history.js';
import { diffSchemas } from '../services/schemaDiff.js';
import { buildDesired } from '../services/desired.js';
import { validateAndStore } from '../services/validation.js';
import { executeScript, preflight } from '../services/executor.js';
import { applyPlan, reconcile } from '../services/reconcile.js';
import { runHealthChecks } from '../services/health.js';

const r = Router();
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
};
const ident63 = z.string().trim().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'Use lowercase letters, digits and underscores');
const envName = z.enum(['development', 'staging', 'production']);

const projectBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(/^[a-z][a-z0-9_]{1,38}$/, 'Slug: lowercase, starts with a letter, 2-39 chars'),
  description: z.string().trim().max(500).optional().default(''),
  primary_table: ident63.optional().nullable(),
});

// ---------- projects ----------

r.get('/', wrap(async (_req, res) => {
  const rows = await q(
    `SELECT p.*,
            (SELECT count(*)::int FROM migration_scripts s WHERE s.project_id = p.id) AS script_count,
            (SELECT max(version) FROM migration_scripts s WHERE s.project_id = p.id) AS latest_version,
            (SELECT count(*)::int FROM app_versions a WHERE a.project_id = p.id AND a.active) AS active_apps,
            (SELECT max(started_at) FROM migration_runs m WHERE m.project_id = p.id) AS last_run_at
       FROM projects p ORDER BY p.name`
  );
  res.json(rows);
}));

r.post('/', validateBody(projectBody), wrap(async (req, res) => {
  const b = req.body;
  const p = await one(
    `INSERT INTO projects (name, slug, description, primary_table) VALUES ($1, $2, $3, $4) RETURNING *`,
    [b.name, b.slug, b.description, b.primary_table || null]
  );
  await audit('project.created', 'project', p.id, { slug: p.slug }, actor(req));
  res.status(201).json(p);
}));

r.get('/:id', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const envs = await listEnvironments();
  const environments = [];
  for (const e of envs) {
    const schema = envSchema(p.slug, e.name);
    const exists = await schemaExists(demo, schema);
    const history = exists ? await readHistory(demo, schema) : [];
    const lastHealth = await q(
      `SELECT check_name, passed, details, created_at FROM health_checks
        WHERE project_id = $1 AND environment_id = $2
          AND created_at = (SELECT max(created_at) FROM health_checks WHERE project_id = $1 AND environment_id = $2)`,
      [p.id, e.id]
    );
    environments.push({
      id: e.id, name: e.name, protected: e.protected, schema, initialized: exists,
      currentVersion: history.length ? Math.max(...history.map((h) => h.version)) : 0,
      history,
      health: lastHealth.length && exists ? { passed: lastHealth.every((h) => h.passed), at: lastHealth[0].created_at, checks: lastHealth } : null,
    });
  }
  res.json({ ...p, environments });
}));

r.put('/:id', validateBody(projectBody.omit({ slug: true })), wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const b = req.body;
  const updated = await one(
    `UPDATE projects SET name = $2, description = $3, primary_table = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [p.id, b.name, b.description, b.primary_table || null]
  );
  await audit('project.updated', 'project', p.id, {}, actor(req));
  res.json(updated);
}));

r.delete('/:id', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  if (req.query.confirm !== p.slug) throw badRequest(`Pass ?confirm=${p.slug} to delete this project`);
  const running = await one(`SELECT 1 FROM migration_runs WHERE project_id = $1 AND status = 'running'`, [p.id]);
  if (running) throw conflict('A migration is running for this project');
  await q('DELETE FROM projects WHERE id = $1', [p.id]);
  await audit('project.deleted', 'project', p.id, { slug: p.slug, note: 'demo schemas are kept' }, actor(req));
  res.status(204).end();
}));

// ---------- migration scripts ----------

const scriptBody = z.object({
  version: z.coerce.number().int().positive().max(1000000),
  description: z.string().trim().min(3).max(160),
  phase: z.enum(['standard', 'expand', 'migrate', 'contract']).default('standard'),
  up_sql: z.string().min(1).max(100000),
  down_sql: z.string().max(100000).optional().nullable(),
});

r.get('/:id/scripts', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const rows = await q(
    `SELECT s.*,
            v.passed AS last_passed, v.error_count, v.warning_count, v.created_at AS validated_at,
            (SELECT array_agg(DISTINCT e.name) FROM migration_runs mr JOIN environments e ON e.id = mr.environment_id
              WHERE mr.script_id = s.id AND mr.status = 'success') AS applied_in
       FROM migration_scripts s
       LEFT JOIN LATERAL (SELECT * FROM validation_results WHERE script_id = s.id ORDER BY id DESC LIMIT 1) v ON TRUE
      WHERE s.project_id = $1 ORDER BY s.version`,
    [p.id]
  );
  res.json(rows);
}));

r.post('/:id/scripts', validateBody(scriptBody), wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const b = req.body;
  const s = await one(
    `INSERT INTO migration_scripts (project_id, version, description, phase, up_sql, down_sql, checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [p.id, b.version, b.description, b.phase, b.up_sql, b.down_sql || null, checksum(b.up_sql, b.down_sql)]
  );
  await audit('script.created', 'script', s.id, { project: p.slug, version: s.version }, actor(req));
  res.status(201).json(s);
}));

async function assertNeverApplied(script) {
  const ran = await one(
    `SELECT 1 FROM migration_runs WHERE script_id = $1 AND status IN ('success', 'running')`,
    [script.id]
  );
  if (ran) throw conflict('This script is applied somewhere. Applied scripts are immutable; create a new version instead.');
}

r.get('/:id/scripts/:sid', wrap(async (req, res) => {
  const s = await getScript(id(req.params.sid));
  if (s.project_id !== id(req.params.id)) throw notFound('Migration script');
  const validations = await q('SELECT * FROM validation_results WHERE script_id = $1 ORDER BY id DESC LIMIT 10', [s.id]);
  res.json({ ...s, validations });
}));

r.put('/:id/scripts/:sid', validateBody(scriptBody), wrap(async (req, res) => {
  const s = await getScript(id(req.params.sid));
  if (s.project_id !== id(req.params.id)) throw notFound('Migration script');
  await assertNeverApplied(s);
  const b = req.body;
  const updated = await one(
    `UPDATE migration_scripts
        SET version = $2, description = $3, phase = $4, up_sql = $5, down_sql = $6, checksum = $7,
            status = 'draft', updated_at = now()
      WHERE id = $1 RETURNING *`,
    [s.id, b.version, b.description, b.phase, b.up_sql, b.down_sql || null, checksum(b.up_sql, b.down_sql)]
  );
  await audit('script.updated', 'script', s.id, { version: updated.version }, actor(req));
  res.json(updated);
}));

r.patch('/:id/scripts/:sid/status', validateBody(z.object({ status: z.enum(['draft', 'rejected']) })), wrap(async (req, res) => {
  const s = await getScript(id(req.params.sid));
  if (s.project_id !== id(req.params.id)) throw notFound('Migration script');
  await assertNeverApplied(s);
  const updated = await one(
    `UPDATE migration_scripts SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [s.id, req.body.status]
  );
  await audit(`script.${req.body.status}`, 'script', s.id, { version: s.version }, actor(req));
  res.json(updated);
}));

r.delete('/:id/scripts/:sid', wrap(async (req, res) => {
  const s = await getScript(id(req.params.sid));
  if (s.project_id !== id(req.params.id)) throw notFound('Migration script');
  const anyRun = await one('SELECT 1 FROM migration_runs WHERE script_id = $1', [s.id]);
  if (anyRun) throw conflict('Script has run history. Mark it rejected instead of deleting it.');
  await q('DELETE FROM migration_scripts WHERE id = $1', [s.id]);
  await audit('script.deleted', 'script', s.id, { version: s.version }, actor(req));
  res.status(204).end();
}));

r.post('/:id/scripts/:sid/validate',
  validateBody(z.object({ dryRunEnvironment: envName.optional().nullable() })),
  wrap(async (req, res) => {
    const s = await getScript(id(req.params.sid));
    if (s.project_id !== id(req.params.id)) throw notFound('Migration script');
    res.json(await validateAndStore(s.id, { dryRunEnv: req.body.dryRunEnvironment, actor: actor(req) }));
  }));

r.get('/:id/scripts/:sid/preflight', wrap(async (req, res) => {
  const s = await getScript(id(req.params.sid));
  const p = await getProject(s.project_id);
  const env = await getEnvironment(envName.parse(req.query.environment));
  const result = await preflight(s, p, env, { acknowledgeWarnings: true, confirm: p.slug });
  const v = await one('SELECT warning_count FROM validation_results WHERE script_id = $1 ORDER BY id DESC LIMIT 1', [s.id]);
  res.json({ ok: result.ok, reasons: result.reasons, needsConfirm: env.protected, warnings: v?.warning_count || 0 });
}));

r.post('/:id/scripts/:sid/execute',
  validateBody(z.object({
    environment: envName,
    acknowledgeWarnings: z.boolean().optional().default(false),
    confirm: z.string().max(60).optional(),
  })),
  wrap(async (req, res) => {
    const s = await getScript(id(req.params.sid));
    if (s.project_id !== id(req.params.id)) throw notFound('Migration script');
    const result = await executeScript({ scriptId: s.id, ...req.body, actor: actor(req) });
    res.json(result);
  }));

// ---------- app versions / compatibility requirements ----------

const appBody = z.object({
  version: z.string().trim().regex(/^[\w.-]{1,20}$/, 'Version like v1.2'),
  requirements: z.array(z.object({ table: ident63, column: ident63 })).min(1).max(200),
});

r.get('/:id/apps', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const rows = await q(
    `SELECT a.*, coalesce(json_agg(json_build_object('table', r.table_name, 'column', r.column_name)
              ORDER BY r.table_name, r.column_name) FILTER (WHERE r.id IS NOT NULL), '[]') AS requirements
       FROM app_versions a LEFT JOIN app_requirements r ON r.app_version_id = a.id
      WHERE a.project_id = $1 GROUP BY a.id ORDER BY a.created_at`,
    [p.id]
  );
  res.json(rows);
}));

r.post('/:id/apps', validateBody(appBody), wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const client = await meta.connect();
  try {
    await client.query('BEGIN');
    const { rows: [app] } = await client.query(
      'INSERT INTO app_versions (project_id, version) VALUES ($1, $2) RETURNING *', [p.id, req.body.version]
    );
    for (const rq of req.body.requirements) {
      await client.query(
        `INSERT INTO app_requirements (app_version_id, table_name, column_name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [app.id, rq.table, rq.column]
      );
    }
    await client.query('COMMIT');
    await audit('app.registered', 'project', p.id, { version: app.version }, actor(req));
    res.status(201).json(app);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

r.patch('/:id/apps/:aid', validateBody(z.object({ active: z.boolean() })), wrap(async (req, res) => {
  const app = await one(
    'UPDATE app_versions SET active = $3 WHERE id = $1 AND project_id = $2 RETURNING *',
    [id(req.params.aid), id(req.params.id), req.body.active]
  );
  if (!app) throw notFound('App version');
  await audit(req.body.active ? 'app.activated' : 'app.retired', 'project', app.project_id, { version: app.version }, actor(req));
  res.json(app);
}));

r.delete('/:id/apps/:aid', wrap(async (req, res) => {
  const app = await one('DELETE FROM app_versions WHERE id = $1 AND project_id = $2 RETURNING *',
    [id(req.params.aid), id(req.params.id)]);
  if (!app) throw notFound('App version');
  await audit('app.deleted', 'project', app.project_id, { version: app.version }, actor(req));
  res.status(204).end();
}));

// ---------- schema views ----------

r.get('/:id/schema', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const env = envName.parse(req.query.environment || 'development');
  const schema = envSchema(p.slug, env);
  const exists = await schemaExists(demo, schema);
  res.json({ environment: env, schema, initialized: exists, ...(exists ? await introspect(demo, schema) : { tables: {} }) });
}));

// left/right can be an environment name or "desired"
r.get('/:id/compare', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const side = z.enum(['development', 'staging', 'production', 'desired']);
  const left = side.parse(req.query.left || 'desired');
  const right = side.parse(req.query.right || 'development');

  const load = async (which) => {
    if (which === 'desired') {
      const scripts = (await listScripts(p.id)).filter((s) => s.status === 'validated');
      const d = await buildDesired(scripts);
      return { label: 'desired (validated scripts)', schema: d.schema, error: d.error };
    }
    const schema = envSchema(p.slug, which);
    const exists = await schemaExists(demo, schema);
    return { label: which, schema: exists ? await introspect(demo, schema) : { tables: {} }, error: null };
  };

  const [a, b] = [await load(left), await load(right)];
  res.json({ left: { name: left, ...a }, right: { name: right, ...b }, differences: diffSchemas(a.schema, b.schema) });
}));

// ---------- reconciliation ----------

r.get('/:id/reconcile', wrap(async (req, res) => {
  res.json(await reconcile(id(req.params.id), envName.parse(req.query.environment || 'development')));
}));

r.post('/:id/reconcile/apply',
  validateBody(z.object({
    environment: envName,
    acknowledgeWarnings: z.boolean().optional().default(false),
    confirm: z.string().max(60).optional(),
  })),
  wrap(async (req, res) => {
    res.json(await applyPlan(id(req.params.id), req.body.environment, {
      acknowledgeWarnings: req.body.acknowledgeWarnings, confirm: req.body.confirm, actor: actor(req),
    }));
  }));

// ---------- health ----------

r.get('/:id/health', wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const rows = await q(
    `SELECT h.*, e.name AS environment FROM health_checks h JOIN environments e ON e.id = h.environment_id
      WHERE h.project_id = $1 ORDER BY h.id DESC LIMIT 200`,
    [p.id]
  );
  res.json(rows);
}));

r.post('/:id/health/run', validateBody(z.object({ environment: envName })), wrap(async (req, res) => {
  const p = await getProject(id(req.params.id));
  const env = await getEnvironment(req.body.environment);
  const result = await runHealthChecks(p, env);
  await audit('health.checked', 'project', p.id, { env: env.name, passed: result.passed }, actor(req));
  res.json(result);
}));

export default r;
