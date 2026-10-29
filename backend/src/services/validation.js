import { demo, envSchema, ident, one, q } from '../db.js';
import { audit } from './audit.js';
import { readHistory } from './history.js';
import { schemaExists } from './introspect.js';
import { validateScript } from './validator.js';
import { activeRequirements, appliedVersions, getEnvironment, getProject, getScript, listScripts } from './projects.js';

// Runs the up script (and the down script, if any) for real against the
// chosen environment, then rolls everything back. PostgreSQL DDL is
// transactional, so this tells us whether the SQL actually works on that data.
export async function dryRun(script, project, env) {
  const schema = envSchema(project.slug, env.name);
  const history = (await schemaExists(demo, schema)) ? await readHistory(demo, schema) : [];
  const applied = new Set(history.map((h) => h.version));
  const scripts = await listScripts(project.id);
  const missing = scripts.filter((s) => s.version < script.version && s.status !== 'rejected' && !applied.has(s.version));

  if (applied.has(script.version)) {
    return { environment: env.name, skipped: true, reason: `V${script.version} is already applied in ${env.name}` };
  }
  if (missing.length) {
    return { environment: env.name, skipped: true, reason: `${env.name} is missing V${missing.map((m) => m.version).join(', V')}` };
  }

  const client = await demo.connect();
  const result = { environment: env.name, skipped: false, up: null, down: null };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
    await client.query(`SET LOCAL search_path TO ${ident(schema)}`);
    await client.query(`SET LOCAL lock_timeout = 2000`);
    await client.query(`SET LOCAL statement_timeout = 15000`);

    const strip = (sql) => sql.replace(/\bCONCURRENTLY\b/gi, '');
    let t0 = Date.now();
    try {
      await client.query(strip(script.up_sql));
      result.up = { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      result.up = { ok: false, ms: Date.now() - t0, error: err.message, code: err.code };
    }

    if (result.up.ok && script.down_sql && script.down_sql.trim()) {
      t0 = Date.now();
      try {
        await client.query('SAVEPOINT down_test');
        await client.query(strip(script.down_sql));
        result.down = { ok: true, ms: Date.now() - t0 };
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT down_test');
        result.down = { ok: false, ms: Date.now() - t0, error: err.message, code: err.code };
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  return result;
}

export async function validateAndStore(scriptId, { dryRunEnv, actor } = {}) {
  const script = await getScript(scriptId);
  const project = await getProject(script.project_id);
  const requirements = await activeRequirements(project.id);
  const applied = await appliedVersions(project.id);

  const report = validateScript(
    { version: script.version, upSql: script.up_sql, downSql: script.down_sql, phase: script.phase },
    { requirements, appliedVersions: applied }
  );

  let dry = null;
  if (dryRunEnv && report.passed) {
    const env = await getEnvironment(dryRunEnv);
    dry = await dryRun(script, project, env);
    if (dry.up && !dry.up.ok) {
      report.passed = false;
      report.errors++;
      report.issues.push({ rule: 'dry-run-failed', severity: 'error', message: `Dry run on ${env.name} failed: ${dry.up.error}` });
    }
    if (dry.down && !dry.down.ok) {
      report.warnings++;
      report.issues.push({ rule: 'dry-run-down-failed', severity: 'warning', message: `Down script failed in dry run: ${dry.down.error}` });
    }
  }

  const saved = await one(
    `INSERT INTO validation_results (script_id, passed, error_count, warning_count, issues, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [script.id, report.passed, report.errors, report.warnings, JSON.stringify(report.issues), dry ? JSON.stringify(dry) : null]
  );

  await q(`UPDATE migration_scripts SET status = $2, updated_at = now() WHERE id = $1`,
    [script.id, report.passed ? 'validated' : 'rejected']);

  await audit('script.validated', 'script', script.id,
    { version: script.version, passed: report.passed, errors: report.errors, warnings: report.warnings, dryRun: dryRunEnv || null }, actor);

  return { ...report, id: saved.id, dryRun: dry, createdAt: saved.created_at };
}
