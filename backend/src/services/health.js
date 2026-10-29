import { demo, envSchema, ident, q } from '../db.js';
import { introspect, schemaExists } from './introspect.js';
import { readHistory } from './history.js';
import { buildDesired } from './desired.js';
import { diffSchemas } from './schemaDiff.js';
import { activeRequirements, listScripts } from './projects.js';

// Groups requirements into one SELECT per (app version, table), which is
// roughly what each running service does when it reads its data.
export function buildProbes(requirements) {
  const map = new Map();
  for (const r of requirements) {
    const key = `${r.appVersion}|${r.table}`;
    if (!map.has(key)) map.set(key, { appVersion: r.appVersion, table: r.table, columns: [] });
    map.get(key).columns.push(r.column);
  }
  return [...map.values()];
}

export function probeSql(schema, probe) {
  const cols = probe.columns.map(ident).join(', ');
  return `SELECT ${cols} FROM ${ident(schema)}.${ident(probe.table)} LIMIT 1`;
}

export async function runHealthChecks(project, env, runId = null) {
  const schema = envSchema(project.slug, env.name);
  const results = [];
  const add = (check, passed, details) => results.push({ check, passed, details });

  const exists = await schemaExists(demo, schema);
  add('schema_reachable', exists, exists ? `Schema ${schema} reachable` : `Schema ${schema} does not exist yet`);

  if (exists) {
    const requirements = await activeRequirements(project.id);
    const probes = buildProbes(requirements);
    const client = await demo.connect();
    try {
      await client.query('SET statement_timeout = 2000');
      for (const p of probes) {
        try {
          await client.query(probeSql(schema, p));
          add(`compat_probe:${p.appVersion}:${p.table}`, true, `app ${p.appVersion} can read ${p.table}(${p.columns.join(', ')})`);
        } catch (err) {
          add(`compat_probe:${p.appVersion}:${p.table}`, false, `app ${p.appVersion} query failed: ${err.message}`);
        }
      }
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
    if (!probes.length) add('compat_probe', true, 'No active app versions registered');

    const history = await readHistory(demo, schema);
    const scripts = await listScripts(project.id);
    const byVersion = new Map(scripts.map((s) => [s.version, s]));
    const bad = history.filter((h) => !byVersion.has(h.version) || byVersion.get(h.version).checksum !== h.checksum);
    add('history_checksums', bad.length === 0,
      bad.length ? `Checksum mismatch for version(s) ${bad.map((b) => b.version).join(', ')}` : `${history.length} applied version(s) match repository`);

    const actual = await introspect(demo, schema);
    const invalid = [];
    const notValid = [];
    for (const [t, def] of Object.entries(actual.tables)) {
      def.indexes.filter((i) => !i.valid).forEach((i) => invalid.push(`${t}.${i.name}`));
      def.constraints.filter((c) => !c.validated).forEach((c) => notValid.push(`${t}.${c.name}`));
    }
    add('index_validity', invalid.length === 0, invalid.length ? `Invalid index(es): ${invalid.join(', ')}` : 'All indexes valid');
    add('constraint_validity', true, notValid.length ? `Not yet validated: ${notValid.join(', ')}` : 'All constraints validated');

    const appliedScripts = history.map((h) => byVersion.get(h.version)).filter(Boolean);
    const expected = await buildDesired(appliedScripts);
    if (expected.error) {
      add('schema_consistency', false, `Could not rebuild expected schema at v${expected.failedAt}: ${expected.error}`);
    } else {
      const drift = diffSchemas(expected.schema, actual);
      add('schema_consistency', drift.length === 0,
        drift.length ? `${drift.length} difference(s): ${drift.slice(0, 3).map((d) => d.message).join('; ')}` : 'Actual schema matches applied history');
    }
  }

  // One statement so the whole batch shares a single created_at timestamp.
  if (results.length) {
    const values = [];
    const params = [];
    results.forEach((r, i) => {
      const b = i * 6;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
      params.push(project.id, env.id, runId, r.check, r.passed, r.details);
    });
    await q(
      `INSERT INTO health_checks (project_id, environment_id, run_id, check_name, passed, details)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  // A schema that doesn't exist yet is "empty", not "broken".
  const critical = results.filter((r) => r.check !== 'schema_reachable');
  return {
    environment: env.name,
    schema,
    passed: exists ? critical.every((r) => r.passed) : true,
    initialized: exists,
    checks: results,
  };
}
