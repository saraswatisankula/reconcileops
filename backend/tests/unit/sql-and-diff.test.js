import { describe, expect, it } from 'vitest';
import { checksum, splitStatements } from '../../src/utils/sql.js';
import { diffSchemas } from '../../src/services/schemaDiff.js';
import { runFilters } from '../../src/services/metrics.js';
import { buildProbes } from '../../src/services/health.js';

describe('splitStatements', () => {
  it('splits on semicolons outside quotes and $$ blocks', () => {
    const sql = `CREATE TABLE a (id INT);
INSERT INTO a VALUES (1); -- comment; with semicolon
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
INSERT INTO notes VALUES ('a;b');`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(4);
    expect(parts[2]).toMatch(/RETURN NEW; END \$\$$/);
    expect(parts[3]).toContain("'a;b'");
  });
});

describe('checksum', () => {
  it('is stable across line endings and changes with content', () => {
    expect(checksum('SELECT 1;\r\n', null)).toBe(checksum('SELECT 1;\n', ''));
    expect(checksum('SELECT 1;', null)).not.toBe(checksum('SELECT 2;', null));
    expect(checksum('SELECT 1;', 'SELECT 0;')).not.toBe(checksum('SELECT 1;', null));
  });
});

const schema = (cols, extra = {}) => ({
  tables: { products: { columns: cols, indexes: [], constraints: [], ...extra } },
});

describe('diffSchemas', () => {
  it('reports missing, extra and changed columns', () => {
    const desired = schema({ id: { type: 'integer', nullable: false }, price_cents: { type: 'integer', nullable: false } });
    const actual = schema({ id: { type: 'bigint', nullable: false }, price: { type: 'numeric', nullable: false } });
    const kinds = diffSchemas(desired, actual).map((d) => d.kind).sort();
    expect(kinds).toEqual(['column_extra', 'column_missing', 'column_type']);
  });

  it('reports missing and extra tables', () => {
    const kinds = diffSchemas({ tables: { a: { columns: {}, indexes: [], constraints: [] } } }, { tables: { b: { columns: {}, indexes: [], constraints: [] } } })
      .map((d) => d.kind);
    expect(kinds).toEqual(['table_missing', 'table_extra']);
  });

  it('returns nothing for identical schemas', () => {
    const s = schema({ id: { type: 'integer', nullable: false } }, { indexes: [{ name: 'p', def: 'CREATE INDEX p ON products (id)' }] });
    expect(diffSchemas(s, s)).toEqual([]);
  });
});

describe('runFilters', () => {
  it('parameterises every value', () => {
    const f = runFilters({ projectId: 3, environment: "x'; DROP TABLE runs; --", status: 'failed' });
    expect(f.where).toBe('WHERE r.project_id = $1 AND e.name = $2 AND r.status = $3');
    expect(f.params[1]).toBe("x'; DROP TABLE runs; --");
  });
});

describe('buildProbes', () => {
  it('groups columns per app version and table', () => {
    const probes = buildProbes([
      { appVersion: 'v1', table: 'products', column: 'id' },
      { appVersion: 'v1', table: 'products', column: 'name' },
      { appVersion: 'v2', table: 'products', column: 'id' },
    ]);
    expect(probes).toEqual([
      { appVersion: 'v1', table: 'products', columns: ['id', 'name'] },
      { appVersion: 'v2', table: 'products', columns: ['id'] },
    ]);
  });
});
