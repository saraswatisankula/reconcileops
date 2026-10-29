import { splitStatements, stripNoise } from '../utils/sql.js';

// Static checks for a migration script. This is pattern based, not a full SQL
// parser, so it is deliberately strict: anything it can't understand gets a
// warning and the dry run + post-deploy health checks act as a second net.

const UNSAFE = [
  [/\b(CREATE|DROP|ALTER)\s+(DATABASE|SCHEMA|ROLE|USER|EXTENSION|TABLESPACE)\b/i, 'Database/schema/role level changes are not allowed in service migrations'],
  [/\bALTER\s+SYSTEM\b/i, 'ALTER SYSTEM changes server configuration'],
  [/\b(GRANT|REVOKE)\b/i, 'Permission changes must be handled outside migration scripts'],
  [/\bCOPY\b[\s\S]*\bPROGRAM\b/i, 'COPY ... PROGRAM can run shell commands'],
  [/\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_write_file|lo_import|lo_export|dblink\w*)\s*\(/i, 'File system / remote connection functions are blocked'],
  [/\b(pg_terminate_backend|pg_cancel_backend)\s*\(/i, 'Killing sessions from a migration is blocked'],
  [/\bSET\s+(SESSION\s+|LOCAL\s+)?(ROLE|SESSION\s+AUTHORIZATION|search_path)\b/i, 'Scripts may not change role or search_path'],
  [/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT)\b/i, 'Transaction control is handled by the executor'],
  [/\brops_schema_history\b/i, 'The schema history table is managed by ReconcileOps'],
  [/\b(TABLE|INTO|FROM|UPDATE|REFERENCES)\s+(ONLY\s+)?(IF\s+(NOT\s+)?EXISTS\s+)?"?[a-z_][a-z0-9_]*"?\s*\.\s*"?[a-z_]/i, 'Use unqualified table names; the executor targets the right schema'],
];

const name = '"?([a-z_][a-z0-9_]*)"?';

function issue(rule, severity, message, statement, suggestion) {
  return {
    rule,
    severity,
    message,
    statement: statement ? statement.replace(/\s+/g, ' ').slice(0, 160) : undefined,
    suggestion,
  };
}

function requiredBy(reqs, table, column) {
  return reqs.filter(
    (r) => r.table === table && (column === undefined || r.column === column)
  );
}

function describeApps(list) {
  return [...new Set(list.map((r) => r.appVersion))].join(', ');
}

export function analyzeStatement(raw, ctx) {
  const out = [];
  const clean = stripNoise(raw);
  const s = clean.replace(/\s+/g, ' ').trim();
  const reqs = ctx.requirements || [];

  for (const [re, msg] of UNSAFE) {
    if (re.test(s)) out.push(issue('unsafe-sql', 'error', msg, raw));
  }

  if (/^DO\b/i.test(s)) {
    out.push(issue('opaque-block', 'warning',
      'DO blocks cannot be analyzed statically', raw,
      'Prefer plain SQL. The dry run and health checks are the only safety net here.'));
  }

  let m;

  if ((m = s.match(new RegExp(`^DROP TABLE (IF EXISTS )?${name}`, 'i')))) {
    const table = m[2].toLowerCase();
    const users = requiredBy(reqs, table);
    if (users.length) {
      out.push(issue('drop-table', 'error',
        `Table "${table}" is still read by app ${describeApps(users)}`, raw,
        'Retire those app versions first, then drop in a contract step.'));
    } else {
      out.push(issue('drop-table', ctx.phase === 'contract' ? 'warning' : 'error',
        `Dropping table "${table}" destroys data`, raw,
        'Only drop tables in a contract-phase script after a backup.'));
    }
  }

  if (/^TRUNCATE\b/i.test(s)) {
    out.push(issue('data-loss', 'error', 'TRUNCATE removes all rows', raw));
  }
  if (/^DELETE FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) {
    out.push(issue('data-loss', 'error', 'DELETE without WHERE removes all rows', raw));
  }
  if (/^LOCK\b/i.test(s)) {
    out.push(issue('explicit-lock', 'warning', 'Explicit LOCK blocks other sessions', raw));
  }

  if ((m = s.match(new RegExp(`^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?`, 'i')))) {
    if (!m[2]) {
      out.push(issue('blocking-index', 'warning',
        'CREATE INDEX without CONCURRENTLY blocks writes while it builds', raw,
        'Use CREATE INDEX CONCURRENTLY in a script of its own.'));
    }
  }

  if ((m = s.match(new RegExp(`^ALTER TABLE (IF EXISTS )?(ONLY )?${name} (.*)$`, 'i')))) {
    const table = m[3].toLowerCase();
    const body = m[4];

    if ((m = body.match(new RegExp(`^RENAME COLUMN ${name} TO ${name}`, 'i')) ||
        body.match(new RegExp(`^RENAME ${name} TO ${name}`, 'i')))) {
      const col = m[1].toLowerCase();
      const users = requiredBy(reqs, table, col);
      out.push(issue('rename-column', users.length ? 'error' : 'warning',
        users.length
          ? `Renaming "${table}.${col}" breaks app ${describeApps(users)}`
          : `Renaming "${table}.${col}" breaks any reader still using the old name`,
        raw, 'Expand: add the new column and backfill. Contract: drop the old one later.'));
    } else if ((m = body.match(new RegExp(`^RENAME TO ${name}`, 'i')))) {
      const users = requiredBy(reqs, table);
      out.push(issue('rename-table', users.length ? 'error' : 'warning',
        `Renaming table "${table}" breaks existing queries`, raw,
        'Create the new table (or a view) and migrate readers first.'));
    }

    for (const action of body.split(/,(?![^(]*\))/)) {
      const a = action.trim();

      if ((m = a.match(new RegExp(`^DROP (COLUMN )?(IF EXISTS )?${name}`, 'i'))) && !/^DROP CONSTRAINT/i.test(a)) {
        const col = m[3].toLowerCase();
        const users = requiredBy(reqs, table, col);
        if (users.length) {
          out.push(issue('drop-column', 'error',
            `Column "${table}.${col}" is still required by app ${describeApps(users)}`, raw,
            'Mark those app versions as retired before the contract step.'));
        } else if (ctx.phase !== 'contract') {
          out.push(issue('drop-column', 'warning',
            `Dropping "${table}.${col}" outside a contract phase`, raw,
            'Drops belong in the contract phase of an expand/contract rollout.'));
        }
      }

      if (/^ADD (COLUMN )?/i.test(a) && !/^ADD (CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)/i.test(a)) {
        if (/\bNOT NULL\b/i.test(a) && !/\bDEFAULT\b/i.test(a)) {
          out.push(issue('not-null-no-default', 'error',
            'New NOT NULL column without DEFAULT fails on existing rows and breaks old writers', raw,
            'Add it nullable (or with a DEFAULT), backfill, then add the constraint.'));
        }
      }

      if ((m = a.match(new RegExp(`^ALTER (COLUMN )?${name} (SET DATA )?TYPE`, 'i')))) {
        const col = m[2].toLowerCase();
        const users = requiredBy(reqs, table, col);
        out.push(issue('type-change', users.length ? 'error' : 'warning',
          `Changing the type of "${table}.${col}" rewrites the table and can break readers`, raw,
          'Add a new column with the new type and migrate in phases.'));
      }

      if (/^ALTER (COLUMN )?\S+ SET NOT NULL/i.test(a)) {
        out.push(issue('set-not-null', 'warning',
          'SET NOT NULL scans the whole table and rejects old writers sending NULL', raw));
      }

      if (/^ADD (CONSTRAINT \S+ )?(CHECK|FOREIGN KEY)\b/i.test(a) && !/\bNOT VALID\b/i.test(a)) {
        out.push(issue('validating-constraint', 'warning',
          'Constraint is validated against all rows while holding a lock', raw,
          'Add with NOT VALID, then VALIDATE CONSTRAINT in a later step.'));
      }
    }
  }

  if (ctx.phase === 'expand' && /^(ALTER TABLE .* (DROP|RENAME)\b|DROP\b)/i.test(s)) {
    out.push(issue('phase-mismatch', 'error',
      'Expand-phase scripts must only add things (tables, columns, indexes, triggers)', raw));
  }

  return out;
}

export function isNonTransactional(sql) {
  return /\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(stripNoise(sql)) ||
    /\bREINDEX\b[\s\S]*\bCONCURRENTLY\b/i.test(stripNoise(sql));
}

/**
 * script: { version, upSql, downSql, phase }
 * ctx: { requirements: [{appVersion, table, column}], appliedVersions: number[] }
 */
export function validateScript(script, ctx = {}) {
  const issues = [];
  const statements = splitStatements(script.upSql || '');

  if (!statements.length) {
    issues.push(issue('empty', 'error', 'Script has no SQL statements'));
  }

  for (const st of statements) {
    issues.push(...analyzeStatement(st, { ...ctx, phase: script.phase }));
  }

  if (isNonTransactional(script.upSql || '') && statements.length > 1) {
    issues.push(issue('concurrent-mixed', 'error',
      'CONCURRENTLY operations cannot run inside a transaction, so they must be the only statement in the script'));
  }

  if (!script.downSql || !script.downSql.trim()) {
    issues.push(issue('irreversible', 'warning',
      'No rollback (down) script. Automatic rollback will not be possible for this version.'));
  } else {
    for (const st of splitStatements(script.downSql)) {
      for (const i of analyzeStatement(st, { phase: 'standard', requirements: [] })) {
        if (i.rule === 'unsafe-sql') issues.push({ ...i, rule: 'unsafe-sql-down', message: `Down script: ${i.message}` });
      }
    }
  }

  const applied = ctx.appliedVersions || [];
  const higher = applied.filter((v) => v > script.version);
  if (higher.length && !applied.includes(script.version)) {
    issues.push(issue('out-of-order', 'error',
      `Version ${script.version} is older than already applied version ${Math.max(...higher)}`,
      undefined, 'Give the script a higher version number.'));
  }

  if (script.phase === 'contract' && /\bADD\s+(COLUMN\s+)?[a-z_]/i.test(stripNoise(script.upSql || '')) &&
      !/\bADD\s+CONSTRAINT\b/i.test(stripNoise(script.upSql || ''))) {
    issues.push(issue('phase-mismatch', 'warning', 'Contract-phase script adds new columns; keep phases focused'));
  }

  // Same rule firing for the same statement only needs to be reported once.
  const seen = new Set();
  const unique = issues.filter((i) => {
    const key = `${i.rule}|${i.message}|${i.statement || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const errors = unique.filter((i) => i.severity === 'error').length;
  const warnings = unique.filter((i) => i.severity === 'warning').length;

  return {
    passed: errors === 0,
    errors,
    warnings,
    statementCount: statements.length,
    nonTransactional: isNonTransactional(script.upSql || ''),
    issues: unique,
  };
}
