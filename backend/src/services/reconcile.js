import { demo, envSchema, q } from '../db.js';
import { audit } from './audit.js';
import { buildDesired } from './desired.js';
import { readHistory } from './history.js';
import { introspect, schemaExists } from './introspect.js';
import { diffSchemas, hasColumn } from './schemaDiff.js';
import { activeRequirements, getEnvironment, getProject, listScripts } from './projects.js';
import { executeScript } from './executor.js';

/*
 * The reconciliation engine looks at four sources of truth:
 *   1. desired  - the schema the validated scripts in the repository produce
 *   2. actual   - the schema that really exists in the environment
 *   3. history  - what the environment's history table + pipeline runs say
 *   4. compat   - the columns that active app versions still need
 * and turns the differences into findings and an ordered plan.
 */
export async function reconcile(projectId, envName) {
  const project = await getProject(projectId);
  const env = await getEnvironment(envName);
  const schema = envSchema(project.slug, env.name);
  const scripts = await listScripts(project.id);
  const requirements = await activeRequirements(project.id);

  const initialized = await schemaExists(demo, schema);
  const history = initialized ? await readHistory(demo, schema) : [];
  const actual = initialized ? await introspect(demo, schema) : { tables: {} };
  const runs = await q(
    `SELECT r.id, s.version FROM migration_runs r JOIN migration_scripts s ON s.id = r.script_id
      WHERE r.project_id = $1 AND r.environment_id = $2 AND r.status = 'success'`,
    [project.id, env.id]
  );

  const findings = [];
  const add = (type, severity, message, extra = {}) => findings.push({ type, severity, message, ...extra });

  const byVersion = new Map(scripts.map((s) => [s.version, s]));
  const appliedVersions = new Set(history.map((h) => h.version));

  // History vs repository
  for (const h of history) {
    const s = byVersion.get(h.version);
    if (!s) add('history', 'error', `V${h.version} is applied but missing from the repository`);
    else if (s.checksum !== h.checksum) add('history', 'error', `V${h.version} was edited after being applied (checksum mismatch)`);
  }
  const runVersions = new Set(runs.map((r) => r.version));
  for (const v of runVersions) {
    if (!appliedVersions.has(v)) add('history', 'error', `Pipeline recorded V${v} as successful but the database has no record of it`);
  }
  for (const v of appliedVersions) {
    if (!runVersions.has(v)) add('history', 'warning', `V${v} is in the database history without a pipeline run (applied outside ReconcileOps?)`);
  }

  // Desired target = every validated script, plus anything already applied.
  const targetScripts = scripts.filter((s) => s.status === 'validated' || appliedVersions.has(s.version));
  const desired = await buildDesired(targetScripts);
  if (desired.error) add('desired', 'error', `Desired schema cannot be built: V${desired.failedAt} fails on an empty schema (${desired.error})`);

  // Expected-at-current-version vs actual = drift
  const appliedScripts = history.map((h) => byVersion.get(h.version)).filter(Boolean);
  const expectedNow = await buildDesired(appliedScripts);
  const drift = expectedNow.error ? [] : diffSchemas(expectedNow.schema, actual);
  for (const d of drift) add('drift', 'error', `Drift: ${d.message}`, { diff: d });

  // Compatibility of actual and desired with running apps
  for (const r of requirements) {
    if (initialized && Object.keys(actual.tables).length && !hasColumn(actual, r.table, r.column)) {
      add('compatibility', 'error', `app ${r.appVersion} needs ${r.table}.${r.column}, which is missing in ${env.name}`);
    }
    if (!desired.error && !hasColumn(desired.schema, r.table, r.column)) {
      add('compatibility', 'error', `Desired schema removes ${r.table}.${r.column}, still used by app ${r.appVersion}`);
    }
  }

  // Pending work
  const maxApplied = history.length ? Math.max(...history.map((h) => h.version)) : 0;
  const pending = scripts.filter((s) => s.status === 'validated' && !appliedVersions.has(s.version));
  const notReady = scripts.filter((s) => s.status === 'draft' && !appliedVersions.has(s.version));
  for (const s of pending) {
    if (s.version < maxApplied) add('history', 'error', `V${s.version} is pending but older than applied V${maxApplied} (out of order)`);
  }
  for (const s of notReady) add('pending', 'info', `V${s.version} is still a draft and is not part of the desired state`);

  const blocking = findings.filter((f) => f.severity === 'error');
  const changes = desired.error ? [] : diffSchemas(desired.schema, actual);

  let state;
  if (blocking.length) state = drift.length ? 'drift' : 'blocked';
  else if (pending.length) state = 'pending';
  else state = 'in_sync';

  return {
    project: { id: project.id, name: project.name, slug: project.slug },
    environment: env.name,
    schema,
    state,
    currentVersion: maxApplied,
    targetVersion: targetScripts.length ? Math.max(...targetScripts.map((s) => s.version)) : 0,
    plan: blocking.length ? [] : pending.map((s) => ({ scriptId: s.id, version: s.version, description: s.description, phase: s.phase })),
    findings,
    changes,
    sources: {
      desiredTables: desired.schema ? Object.keys(desired.schema.tables).length : 0,
      actualTables: Object.keys(actual.tables).length,
      historyEntries: history.length,
      activeRequirements: requirements.length,
    },
  };
}

// Applies the plan one script at a time and stops at the first problem.
export async function applyPlan(projectId, envName, opts) {
  const report = await reconcile(projectId, envName);
  if (report.state === 'in_sync') return { report, results: [] };
  if (!report.plan.length) {
    await audit('reconcile.blocked', 'project', projectId, { env: envName, findings: report.findings.length }, opts.actor);
    return { report, results: [], blocked: true };
  }

  const results = [];
  for (const step of report.plan) {
    try {
      const r = await executeScript({ ...opts, scriptId: step.scriptId, environment: envName });
      results.push({ version: step.version, status: r.run.status, runId: r.run.id });
      if (r.run.status !== 'success' || r.run.needs_manual) break;
    } catch (err) {
      results.push({ version: step.version, status: 'blocked', error: err.message, reasons: err.details?.reasons });
      break;
    }
  }
  await audit('reconcile.applied', 'project', projectId, { env: envName, results }, opts.actor);
  return { report: await reconcile(projectId, envName), results };
}
