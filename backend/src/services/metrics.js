import { q, one } from '../db.js';

// Builds a WHERE clause from the filter query string. Values are always
// passed as parameters, never concatenated.
export function runFilters(query = {}) {
  const where = [];
  const params = [];
  const push = (sql, val) => {
    params.push(val);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (query.projectId) push('r.project_id = ?', Number(query.projectId));
  if (query.environment) push('e.name = ?', String(query.environment));
  if (query.status) push('r.status = ?', String(query.status));
  if (query.from) push('r.started_at >= ?', new Date(query.from));
  if (query.to) push('r.started_at < ?', new Date(new Date(query.to).getTime() + 86400000));
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const BASE = `FROM migration_runs r
  JOIN environments e ON e.id = r.environment_id
  JOIN projects p ON p.id = r.project_id
  JOIN migration_scripts s ON s.id = r.script_id`;

export async function getMetrics(query) {
  const { where, params } = runFilters(query);

  const summary = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE r.status = 'success')::int AS success,
            count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE r.status = 'rolled_back')::int AS rolled_back,
            count(*) FILTER (WHERE r.status = 'blocked')::int AS blocked,
            count(*) FILTER (WHERE r.needs_manual)::int AS manual,
            coalesce(round(avg(r.duration_ms)), 0)::int AS avg_duration_ms,
            coalesce(sum(r.downtime_ms), 0)::int AS total_downtime_ms,
            coalesce(max(r.downtime_ms), 0)::int AS max_downtime_ms,
            coalesce(sum(r.probe_total), 0)::int AS probe_total,
            coalesce(sum(r.probe_failed), 0)::int AS probe_failed,
            count(*) FILTER (WHERE r.probe_total > 0 AND r.probe_failed = 0)::int AS zero_impact_runs,
            count(*) FILTER (WHERE r.probe_total > 0)::int AS probed_runs,
            coalesce(round(avg(r.rollback_ms) FILTER (WHERE r.rollback_ms IS NOT NULL)), 0)::int AS avg_rollback_ms,
            count(*) FILTER (WHERE r.rollback_ms IS NOT NULL)::int AS rollbacks
       ${BASE} ${where}`,
    params
  );

  const finished = summary.success + summary.failed + summary.rolled_back;
  summary.success_rate = finished ? Math.round((summary.success / finished) * 1000) / 10 : null;

  const daily = await q(
    `SELECT to_char(date_trunc('day', r.started_at), 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE r.status = 'success')::int AS success,
            count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE r.status = 'rolled_back')::int AS rolled_back,
            count(*) FILTER (WHERE r.status = 'blocked')::int AS blocked
       ${BASE} ${where}
      GROUP BY 1 ORDER BY 1`,
    params
  );

  const recent = await q(
    `SELECT r.id, p.name AS project, e.name AS environment, s.version, r.status,
            r.duration_ms, r.downtime_ms, r.rollback_ms
       ${BASE} ${where}
      ORDER BY r.id DESC LIMIT 25`,
    params
  );

  const byEnv = await q(
    `SELECT e.name AS environment, count(*)::int AS runs,
            count(*) FILTER (WHERE r.status = 'success')::int AS success
       ${BASE} ${where} GROUP BY e.name, e.stage_order ORDER BY e.stage_order`,
    params
  );

  // Compatibility issues come from validation, filtered by project if asked.
  const vParams = [];
  let vWhere = '';
  if (query.projectId) {
    vParams.push(Number(query.projectId));
    vWhere = 'WHERE ms.project_id = $1';
  }
  const issues = await q(
    `SELECT i->>'rule' AS rule, i->>'severity' AS severity, count(*)::int AS count
       FROM validation_results v
       JOIN migration_scripts ms ON ms.id = v.script_id
       CROSS JOIN LATERAL jsonb_array_elements(v.issues) i
       ${vWhere}
      GROUP BY 1, 2 ORDER BY 3 DESC`,
    vParams
  );
  const validations = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT passed)::int AS rejected
       FROM validation_results v JOIN migration_scripts ms ON ms.id = v.script_id ${vWhere}`,
    vParams
  );

  return {
    summary: {
      ...summary,
      compatibility_issues: issues.filter((i) => i.severity === 'error').reduce((a, b) => a + b.count, 0),
      validations_total: validations.total,
      validations_rejected: validations.rejected,
    },
    daily,
    recent: recent.reverse(),
    byEnv,
    issues,
  };
}

export async function listRuns(query, limit = 200) {
  const { where, params } = runFilters(query);
  return q(
    `SELECT r.id, r.status, r.attempts, r.started_at, r.finished_at, r.duration_ms, r.downtime_ms,
            r.probe_total, r.probe_failed, r.rollback_ms, r.needs_manual, r.error_message, r.error_code,
            r.triggered_by, p.id AS project_id, p.name AS project_name, e.name AS environment,
            s.id AS script_id, s.version, s.description, s.phase
       ${BASE} ${where}
      ORDER BY r.id DESC LIMIT ${Number(limit)}`,
    params
  );
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function runsCsv(query) {
  const rows = await listRuns(query, 10000);
  const cols = ['id', 'project_name', 'environment', 'version', 'description', 'phase', 'status', 'attempts',
    'started_at', 'finished_at', 'duration_ms', 'downtime_ms', 'probe_total', 'probe_failed', 'rollback_ms',
    'needs_manual', 'error_code', 'error_message', 'triggered_by'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
