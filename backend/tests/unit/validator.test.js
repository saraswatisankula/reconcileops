import { describe, expect, it } from 'vitest';
import { validateScript, isNonTransactional } from '../../src/services/validator.js';

const v1Reads = [
  { appVersion: 'v1.0', table: 'products', column: 'id' },
  { appVersion: 'v1.0', table: 'products', column: 'name' },
  { appVersion: 'v1.0', table: 'products', column: 'price' },
];

const run = (upSql, extra = {}, ctx = {}) =>
  validateScript({ version: 10, upSql, downSql: 'SELECT 1;', phase: 'standard', ...extra }, ctx);

const rules = (r) => r.issues.map((i) => `${i.severity}:${i.rule}`);

describe('validator', () => {
  it('passes a plain additive change', () => {
    const r = run('ALTER TABLE products ADD COLUMN stock INT;');
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });

  it('rejects renaming a column a live app reads', () => {
    const r = run('ALTER TABLE products RENAME COLUMN name TO title;', {}, { requirements: v1Reads });
    expect(r.passed).toBe(false);
    expect(rules(r)).toContain('error:rename-column');
  });

  it('only warns about a rename when nobody reads the column', () => {
    const r = run('ALTER TABLE products RENAME COLUMN legacy TO old_legacy;', {}, { requirements: v1Reads });
    expect(r.passed).toBe(true);
    expect(rules(r)).toContain('warning:rename-column');
  });

  it('rejects dropping a required column even in contract phase', () => {
    const r = run('ALTER TABLE products DROP COLUMN price;', { phase: 'contract' }, { requirements: v1Reads });
    expect(r.passed).toBe(false);
    expect(r.issues[0].message).toMatch(/v1\.0/);
  });

  it('allows the contract drop once no app needs the column', () => {
    const r = run('ALTER TABLE products DROP COLUMN price;', { phase: 'contract' }, { requirements: [] });
    expect(r.passed).toBe(true);
  });

  it('flags NOT NULL columns without a default', () => {
    expect(rules(run('ALTER TABLE products ADD COLUMN sku TEXT NOT NULL;'))).toContain('error:not-null-no-default');
    expect(run("ALTER TABLE products ADD COLUMN sku TEXT NOT NULL DEFAULT 'x';").passed).toBe(true);
  });

  it('blocks unsafe statements', () => {
    for (const sql of [
      'DROP SCHEMA public CASCADE;',
      'GRANT ALL ON products TO bob;',
      "COPY products FROM PROGRAM 'rm -rf /';",
      'SET search_path TO other;',
      'COMMIT;',
      'ALTER TABLE public.products ADD COLUMN x INT;',
      "SELECT pg_read_file('/etc/passwd');",
    ]) {
      const r = run(sql);
      expect(r.passed, sql).toBe(false);
      expect(rules(r), sql).toContain('error:unsafe-sql');
    }
  });

  it('ignores dangerous words inside comments and strings', () => {
    const r = run("-- DROP SCHEMA public\nINSERT INTO notes (body) VALUES ('please GRANT access');");
    expect(r.passed).toBe(true);
  });

  it('warns about blocking index builds and wants CONCURRENTLY alone', () => {
    expect(rules(run('CREATE INDEX idx_a ON products (name);'))).toContain('warning:blocking-index');
    const mixed = run('CREATE INDEX CONCURRENTLY idx_a ON products (name); ALTER TABLE products ADD COLUMN x INT;');
    expect(rules(mixed)).toContain('error:concurrent-mixed');
    expect(isNonTransactional('create index concurrently i on t (c)')).toBe(true);
  });

  it('warns about DO blocks it cannot read', () => {
    const r = run("DO $$ BEGIN EXECUTE 'ALTER TABLE products DROP COLUMN price'; END $$;", {}, { requirements: v1Reads });
    expect(r.passed).toBe(true);
    expect(rules(r)).toContain('warning:opaque-block');
  });

  it('rejects destructive statements in an expand phase', () => {
    const r = run('ALTER TABLE products DROP COLUMN legacy;', { phase: 'expand' });
    expect(rules(r)).toContain('error:phase-mismatch');
  });

  it('warns when there is no down script', () => {
    const r = validateScript({ version: 1, upSql: 'CREATE TABLE t (id INT);', downSql: null, phase: 'standard' });
    expect(rules(r)).toContain('warning:irreversible');
  });

  it('rejects out-of-order versions', () => {
    const r = run('ALTER TABLE products ADD COLUMN x INT;', { version: 2 }, { appliedVersions: [1, 3] });
    expect(rules(r)).toContain('error:out-of-order');
  });

  it('rejects data loss', () => {
    expect(run('DELETE FROM products;').passed).toBe(false);
    expect(run('TRUNCATE products;').passed).toBe(false);
    expect(run('DELETE FROM products WHERE id = 1;').passed).toBe(true);
  });

  it('rejects an empty script', () => {
    expect(rules(run('  -- nothing here\n'))).toContain('error:empty');
  });
});
