import { q, one } from '../db.js';
import { notFound } from '../utils/errors.js';

export async function getProject(id) {
  const p = await one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) throw notFound('Project');
  return p;
}

export async function getEnvironment(idOrName) {
  const env = /^\d+$/.test(String(idOrName))
    ? await one('SELECT * FROM environments WHERE id = $1', [Number(idOrName)])
    : await one('SELECT * FROM environments WHERE name = $1', [idOrName]);
  if (!env) throw notFound('Environment');
  return env;
}

export async function listEnvironments() {
  return q('SELECT * FROM environments ORDER BY stage_order');
}

export async function getScript(id) {
  const s = await one('SELECT * FROM migration_scripts WHERE id = $1', [id]);
  if (!s) throw notFound('Migration script');
  return s;
}

export async function listScripts(projectId) {
  return q('SELECT * FROM migration_scripts WHERE project_id = $1 ORDER BY version', [projectId]);
}

// Columns that currently deployed (active) app versions read.
export async function activeRequirements(projectId) {
  const rows = await q(
    `SELECT av.version AS app_version, r.table_name, r.column_name
       FROM app_requirements r
       JOIN app_versions av ON av.id = r.app_version_id
      WHERE av.project_id = $1 AND av.active
      ORDER BY av.version, r.table_name, r.column_name`,
    [projectId]
  );
  return rows.map((r) => ({ appVersion: r.app_version, table: r.table_name, column: r.column_name }));
}

export async function appliedVersions(projectId) {
  const rows = await q(
    `SELECT DISTINCT s.version
       FROM migration_runs r JOIN migration_scripts s ON s.id = r.script_id
      WHERE r.project_id = $1 AND r.status = 'success'`,
    [projectId]
  );
  return rows.map((r) => r.version);
}
