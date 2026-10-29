import { demo, envSchema, ident, one, q } from '../db.js';
import { logger } from '../logger.js';
import { HttpError, badRequest, conflict } from '../utils/errors.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { ensureEnvSchema, readHistory, recordApplied, removeApplied } from './history.js';
import { introspectColumns } from './introspect.js';
import { isNonTransactional } from './validator.js';
import { runHealthChecks } from './health.js';
import { startProbe } from './probe.js';
import {
  activeRequirements, getEnvironment, getProject, getScript, listEnvironments, listScripts,
} from './projects.js';

// lock_not_available, deadlock_detected, serialization_failure
const TRANSIENT = new Set(['55P03', '40P01', '40001']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lockKey(schema) {
  let h = 0;
  for (const ch of schema) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

async function latestValidation(scriptId) {
  return one('SELECT * FROM validation_results WHERE script_id = $1 ORDER BY id DESC LIMIT 1', [scriptId]);
}

// All the "should we even try?" rules live here so they can be shown to the
// user before anything touches the database.
export async function preflight(script, project, env, opts = {}) {
  const settings = await getSettings();
  const schema = envSchema(project.slug, env.name);
  const reasons = [];

  if (script.status !== 'validated') {
    reasons.push(`Script V${script.version} is "${script.status}". Only validated scripts can run.`);
  }
  const v = await latestValidation(script.id);
  if (script.status === 'validated' && v && v.warning_count > 0 && !opts.acknowledgeWarnings) {
    reasons.push(`Script has ${v.warning_count} warning(s); acknowledge them to continue.`);
  }
  if (env.protected && opts.confirm !== project.slug) {
    reasons.push(`"${env.name}" is protected. Type the project slug "${project.slug}" to confirm.`);
  }

  const history = await readHistory(demo, schema);
  const applied = new Set(history.map((h) => h.version));
  if (applied.has(script.version)) {
    reasons.push(`V${script.version} is already applied in ${env.name}.`);
  }

  const scripts = await listScripts(project.id);
  const missing = scripts.filter(
    (s) => s.version < script.version && s.status !== 'rejected' && !applied.has(s.version)
  );
  if (missing.length) {
    reasons.push(`Earlier version(s) not applied in ${env.name}: ${missing.map((m) => 'V' + m.version).join(', ')}`);
  }

  if (settings.enforce_promotion_order && env.stage_order > 1) {
    const envs = await listEnvironments();
    const prev = envs.find((e) => e.stage_order === env.stage_order - 1);
    const prevHistory = await readHistory(demo, envSchema(project.slug, prev.name));
    if (!prevHistory.some((h) => h.version === script.version)) {
      reasons.push(`Promotion order: V${script.version} must succeed in ${prev.name} first.`);
    }
  }

  return { ok: reasons.length === 0, reasons, schema, settings };
}

async function runSql(client, schema, sql, settings, transactional) {
  if (transactional) {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${ident(schema)}`);
    await client.query(`SET LOCAL lock_timeout = ${Number(settings.lock_timeout_ms)}`);
    await client.query(`SET LOCAL statement_timeout = ${Number(settings.statement_timeout_ms)}`);
    await client.query(sql);
  } else {
    await client.query(`SET search_path TO ${ident(schema)}`);
    await client.query(`SET lock_timeout = ${Number(settings.lock_timeout_ms)}`);
    await client.query(sql);
  }
}

async function resetSession(client) {
  await client.query('RESET search_path').catch(() => {});
  await client.query('RESET lock_timeout').catch(() => {});
}

export async function executeScript({ scriptId, environment, actor = 'operator', acknowledgeWarnings = false, confirm }) {
  const script = await getScript(scriptId);
  const project = await getProject(script.project_id);
  const env = await getEnvironment(environment);

  const pre = await preflight(script, project, env, { acknowledgeWarnings, confirm });
  if (!pre.ok) {
    await audit('migration.blocked', 'script', script.id, { env: env.name, reasons: pre.reasons }, actor);
    throw new HttpError(422, 'Migration blocked by pre-flight checks', { reasons: pre.reasons });
  }
  const { schema, settings } = pre;

  let run;
  try {
    run = await one(
      `INSERT INTO migration_runs (project_id, environment_id, script_id, status, triggered_by)
       VALUES ($1, $2, $3, 'running', $4) RETURNING *`,
      [project.id, env.id, script.id, actor]
    );
  } catch (err) {
    if (err.code === '23505') {
      throw conflict(`Another migration is already running for ${project.name} in ${env.name}, or this one already succeeded.`);
    }
    throw err;
  }

  const log = [];
  const note = (msg) => log.push({ at: new Date().toISOString(), msg });
  const client = await demo.connect();
  let gotLock = false;

  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey(schema)]);
    gotLock = lock.rows[0].ok;
    if (!gotLock) {
      note('Advisory lock held by another session');
      await finishRun(run.id, { status: 'blocked', error_message: 'Schema is locked by another migration', log });
      throw conflict('Schema is locked by another migration session.');
    }
    note(`Acquired advisory lock for ${schema}`);

    await ensureEnvSchema(client, schema);
    const before = await introspectColumns(client, schema);
    const requirements = await activeRequirements(project.id);
    const transactional = !isNonTransactional(script.up_sql);
    note(transactional ? 'Running inside a single transaction' : 'Non-transactional script (CONCURRENTLY), running statement directly');

    const probe = startProbe(schema, requirements, before, settings.probe_interval_ms);
    const started = Date.now();
    let attempts = 0;
    let lastErr = null;

    while (attempts <= settings.max_retries) {
      attempts++;
      const t0 = Date.now();
      try {
        await runSql(client, schema, script.up_sql, settings, transactional);
        if (transactional) {
          await recordApplied(client, schema, script, Date.now() - t0);
          await client.query('COMMIT');
        } else {
          await recordApplied(client, schema, script, Date.now() - t0);
        }
        lastErr = null;
        note(`Attempt ${attempts} succeeded in ${Date.now() - t0} ms`);
        break;
      } catch (err) {
        lastErr = err;
        if (transactional) await client.query('ROLLBACK').catch(() => {});
        note(`Attempt ${attempts} failed [${err.code || 'n/a'}]: ${err.message}`);
        if (!TRANSIENT.has(err.code) || attempts > settings.max_retries) break;
        const wait = settings.retry_backoff_ms * attempts;
        note(`Transient error, retrying in ${wait} ms`);
        await sleep(wait);
      } finally {
        await resetSession(client);
      }
    }

    const duration = Date.now() - started;
    const stats = await probe.stop();
    note(`Probe: ${stats.total} reads, ${stats.failed} failed/slow, ${stats.downtimeMs} ms impacted`);

    const base = {
      attempts,
      duration_ms: duration,
      probe_total: stats.total,
      probe_failed: stats.failed,
      downtime_ms: stats.downtimeMs,
    };

    if (lastErr) {
      let needsManual = false;
      if (transactional) {
        note('Transaction rolled back automatically; schema left unchanged');
      } else {
        needsManual = true;
        note('Non-transactional statement failed; an invalid index may be left behind and needs review');
      }
      await finishRun(run.id, {
        ...base, status: 'failed', error_message: lastErr.message, error_code: lastErr.code || null,
        needs_manual: needsManual, log,
      });
      const health = await runHealthChecks(project, env, run.id);
      await audit('migration.failed', 'run', run.id, { version: script.version, env: env.name, error: lastErr.message }, actor);
      return { run: await getRun(run.id), health };
    }

    const health = await runHealthChecks(project, env, run.id);
    if (health.passed) {
      note('Post-deployment health checks passed');
      await finishRun(run.id, { ...base, status: 'success', log });
      await audit('migration.success', 'run', run.id, { version: script.version, env: env.name }, actor);
      return { run: await getRun(run.id), health };
    }

    const failedChecks = health.checks.filter((c) => !c.passed).map((c) => c.check);
    note(`Health checks failed: ${failedChecks.join(', ')}`);

    if (!settings.auto_rollback) {
      note('Auto-rollback disabled; flagged for manual intervention');
      await finishRun(run.id, { ...base, status: 'success', needs_manual: true, error_message: `Unhealthy after deploy: ${failedChecks.join(', ')}`, log });
      await audit('migration.unhealthy', 'run', run.id, { failedChecks }, actor);
      return { run: await getRun(run.id), health };
    }

    if (!script.down_sql || !script.down_sql.trim()) {
      note('No down script exists, so automatic rollback is impossible');
      await finishRun(run.id, { ...base, status: 'success', needs_manual: true, error_message: `Unhealthy after deploy and not reversible: ${failedChecks.join(', ')}`, log });
      await audit('migration.unhealthy', 'run', run.id, { failedChecks, reversible: false }, actor);
      return { run: await getRun(run.id), health };
    }

    const rb = await applyDown(client, schema, script, settings);
    if (rb.ok) {
      note(`Rolled back to previous version in ${rb.ms} ms`);
      await finishRun(run.id, { ...base, status: 'rolled_back', rollback_ms: rb.ms, error_message: `Auto-rollback after failed checks: ${failedChecks.join(', ')}`, log });
    } else {
      note(`Rollback failed: ${rb.error}`);
      await finishRun(run.id, { ...base, status: 'success', needs_manual: true, error_message: `Unhealthy and rollback failed: ${rb.error}`, log });
    }
    const after = await runHealthChecks(project, env, run.id);
    await audit('migration.auto_rollback', 'run', run.id, { ok: rb.ok, failedChecks }, actor);
    return { run: await getRun(run.id), health: after, healthBeforeRollback: health };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error({ err }, 'executor crashed');
    await finishRun(run.id, { status: 'failed', error_message: err.message, needs_manual: true, log });
    throw err;
  } finally {
    if (gotLock) await client.query('SELECT pg_advisory_unlock($1)', [lockKey(schema)]).catch(() => {});
    client.release();
  }
}

async function applyDown(client, schema, script, settings) {
  const t0 = Date.now();
  const transactional = !isNonTransactional(script.down_sql);
  try {
    await runSql(client, schema, script.down_sql, settings, transactional);
    await removeApplied(client, schema, script.version);
    if (transactional) await client.query('COMMIT');
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    if (transactional) await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: err.message, ms: Date.now() - t0 };
  } finally {
    await resetSession(client);
  }
}

// Manual rollback of the most recent version in an environment.
export async function rollbackRun(runId, actor = 'operator', confirm) {
  const run = await getRun(runId);
  if (run.status !== 'success') throw badRequest(`Only successful runs can be rolled back (this one is ${run.status})`);

  const script = await getScript(run.script_id);
  const project = await getProject(run.project_id);
  const env = await getEnvironment(run.environment_id);
  if (env.protected && confirm !== project.slug) {
    throw new HttpError(422, 'Rollback blocked', { reasons: [`Type "${project.slug}" to confirm a rollback in ${env.name}.`] });
  }
  if (!script.down_sql || !script.down_sql.trim()) {
    throw new HttpError(422, 'Rollback blocked', { reasons: [`V${script.version} has no down script. It has to be fixed forward or reverted manually.`] });
  }

  const schema = envSchema(project.slug, env.name);
  const history = await readHistory(demo, schema);
  const latest = Math.max(...history.map((h) => h.version));
  if (latest !== script.version) {
    throw new HttpError(422, 'Rollback blocked', { reasons: [`V${latest} is applied on top of V${script.version}. Roll back newer versions first.`] });
  }

  const settings = await getSettings();
  const client = await demo.connect();
  const key = lockKey(schema);
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!lock.rows[0].ok) throw conflict('Schema is locked by another migration session.');
    try {
      const rb = await applyDown(client, schema, script, settings);
      if (!rb.ok) {
        await audit('rollback.failed', 'run', run.id, { error: rb.error }, actor);
        throw new HttpError(500, `Rollback failed: ${rb.error}`);
      }
      const log = [...(run.log || []), { at: new Date().toISOString(), msg: `Manual rollback by ${actor} in ${rb.ms} ms` }];
      await q(
        `UPDATE migration_runs SET status = 'rolled_back', rollback_ms = $2, log = $3 WHERE id = $1`,
        [run.id, rb.ms, JSON.stringify(log)]
      );
      await audit('rollback.manual', 'run', run.id, { version: script.version, env: env.name, ms: rb.ms }, actor);
      const health = await runHealthChecks(project, env, run.id);
      return { run: await getRun(run.id), health };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function finishRun(id, fields) {
  const f = { finished_at: new Date(), ...fields };
  if (f.log) f.log = JSON.stringify(f.log);
  const keys = Object.keys(f);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await q(`UPDATE migration_runs SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => f[k])]);
}

export async function getRun(id) {
  const run = await one(
    `SELECT r.*, s.version, s.description, s.phase, p.name AS project_name, p.slug AS project_slug,
            e.name AS environment
       FROM migration_runs r
       JOIN migration_scripts s ON s.id = r.script_id
       JOIN projects p ON p.id = r.project_id
       JOIN environments e ON e.id = r.environment_id
      WHERE r.id = $1`,
    [id]
  );
  if (!run) throw new HttpError(404, 'Run not found');
  return run;
}
