import { Router } from 'express';
import { z } from 'zod';
import { config, maskUrl } from '../config.js';
import { demo, envSchema, meta, one, q } from '../db.js';
import { schemaExists } from '../services/introspect.js';
import { readHistory } from '../services/history.js';
import { actor, validateBody } from '../middleware.js';
import { badRequest, notFound, wrap } from '../utils/errors.js';
import { audit } from '../services/audit.js';
import { executeScript, getRun, rollbackRun } from '../services/executor.js';
import { getMetrics, listRuns, runsCsv } from '../services/metrics.js';
import { getSettings, settingsSchema, updateSettings } from '../services/settings.js';
import { DEMO_STEPS, resetDemo, runDemoStep } from '../services/demo.js';
import { listEnvironments } from '../services/projects.js';

const r = Router();

const filterSchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  status: z.enum(['running', 'success', 'failed', 'rolled_back', 'blocked']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const filters = (query) => {
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
  return filterSchema.parse(clean);
};

// ---------- dashboard ----------

r.get('/dashboard', wrap(async (_req, res) => {
  const metrics = await getMetrics({});
  const envs = await listEnvironments();
  const projects = await q('SELECT id, name, slug FROM projects ORDER BY name');

  const health = await q(
    `SELECT h.project_id, e.name AS environment, h.check_name, h.passed, h.created_at
       FROM health_checks h JOIN environments e ON e.id = h.environment_id
      WHERE h.created_at = (SELECT max(created_at) FROM health_checks x
                             WHERE x.project_id = h.project_id AND x.environment_id = h.environment_id)`
  );
  const versions = {};
  for (const p of projects) {
    for (const e of envs) {
      const schema = envSchema(p.slug, e.name);
      const hist = (await schemaExists(demo, schema)) ? await readHistory(demo, schema) : [];
      versions[`${p.id}|${e.name}`] = hist.length ? Math.max(...hist.map((h) => h.version)) : 0;
    }
  }
  const grid = projects.map((p) => ({
    ...p,
    environments: envs.map((e) => {
      const checks = health.filter((h) => h.project_id === p.id && h.environment === e.name);
      // A schema that was never created is "not deployed", not unhealthy.
      const empty = checks.some((c) => c.check_name === 'schema_reachable' && !c.passed);
      return {
        name: e.name,
        version: versions[`${p.id}|${e.name}`],
        checked: checks.length > 0 && !empty,
        passed: checks.length ? checks.every((c) => c.passed) : null,
        failing: checks.filter((c) => !c.passed).map((c) => c.check_name),
        at: checks.length ? checks.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at : null,
      };
    }),
  }));

  const activity = await q('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 8');
  res.json({ metrics, grid, activity });
}));

// ---------- runs ----------

r.get('/runs', wrap(async (req, res) => {
  res.json(await listRuns(filters(req.query)));
}));

r.get('/runs/:id', wrap(async (req, res) => {
  const run = await getRun(Number(req.params.id));
  const health = await q('SELECT * FROM health_checks WHERE run_id = $1 ORDER BY id', [run.id]);
  res.json({ ...run, health });
}));

r.post('/runs/:id/rollback', validateBody(z.object({ confirm: z.string().max(60).optional() })), wrap(async (req, res) => {
  res.json(await rollbackRun(Number(req.params.id), actor(req), req.body.confirm));
}));

r.post('/runs/:id/retry',
  validateBody(z.object({ acknowledgeWarnings: z.boolean().optional(), confirm: z.string().max(60).optional() })),
  wrap(async (req, res) => {
    const run = await getRun(Number(req.params.id));
    if (!['failed', 'blocked', 'rolled_back'].includes(run.status)) {
      throw badRequest('Only failed, blocked or rolled back runs can be retried');
    }
    await audit('run.retry', 'run', run.id, {}, actor(req));
    res.json(await executeScript({
      scriptId: run.script_id, environment: run.environment, actor: actor(req),
      acknowledgeWarnings: req.body.acknowledgeWarnings, confirm: req.body.confirm,
    }));
  }));

// ---------- metrics / reports ----------

r.get('/metrics', wrap(async (req, res) => {
  res.json(await getMetrics(filters(req.query)));
}));

r.get('/reports/runs.csv', wrap(async (req, res) => {
  const csv = await runsCsv(filters(req.query));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reconcileops-runs-${stamp}.csv"`);
  res.send(csv);
}));

// ---------- audit ----------

r.get('/audit', wrap(async (req, res) => {
  const p = z.object({
    action: z.string().max(60).optional(),
    entity: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  const where = [];
  const params = [];
  if (p.action) { params.push(p.action + '%'); where.push(`action LIKE $${params.length}`); }
  if (p.entity) { params.push(p.entity); where.push(`entity = $${params.length}`); }
  params.push(p.limit);
  const rows = await q(
    `SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

// ---------- settings / environments ----------

r.get('/settings', wrap(async (_req, res) => res.json(await getSettings())));

r.put('/settings', validateBody(settingsSchema.partial()), wrap(async (req, res) => {
  const saved = await updateSettings(req.body);
  await audit('settings.updated', 'settings', null, req.body, actor(req));
  res.json(saved);
}));

r.get('/environments', wrap(async (_req, res) => res.json(await listEnvironments())));

r.patch('/environments/:id', validateBody(z.object({
  description: z.string().max(300).optional(),
  protected: z.boolean().optional(),
})), wrap(async (req, res) => {
  const env = await one(
    `UPDATE environments SET description = coalesce($2, description), protected = coalesce($3, protected)
      WHERE id = $1 RETURNING *`,
    [Number(req.params.id), req.body.description ?? null, req.body.protected ?? null]
  );
  if (!env) throw notFound('Environment');
  await audit('environment.updated', 'environment', env.id, req.body, actor(req));
  res.json(env);
}));

r.get('/system', wrap(async (_req, res) => {
  const ping = async (pool) => {
    const t0 = Date.now();
    try {
      const v = await pool.query('SHOW server_version');
      return { ok: true, ms: Date.now() - t0, version: v.rows[0].server_version };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  res.json({
    nodeEnv: config.NODE_ENV,
    authEnabled: Boolean(config.API_TOKEN),
    metaDatabase: { url: maskUrl(config.META_DATABASE_URL), ...(await ping(meta)) },
    demoDatabase: { url: maskUrl(config.DEMO_DATABASE_URL), ...(await ping(demo)) },
    corsOrigin: config.CORS_ORIGIN,
  });
}));

// ---------- demo ----------

r.get('/demo/steps', (_req, res) => {
  res.json(DEMO_STEPS.map(({ key, group, title, explain, expect }) => ({ key, group, title, explain, expect })));
});

r.post('/demo/reset', wrap(async (req, res) => res.json(await resetDemo(actor(req)))));

r.post('/demo/steps/:key', wrap(async (req, res) => {
  const result = await runDemoStep(req.params.key);
  if (!result) throw notFound('Demo step');
  res.json(result);
}));

export default r;
