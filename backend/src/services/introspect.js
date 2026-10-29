import { HISTORY_TABLE } from './history.js';

// Reads the real structure of a schema from the PostgreSQL catalog.
// `db` can be a pool or a client (a client lets us read inside a transaction).
export async function introspect(db, schema) {
  const cols = await db.query(
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
            c.is_nullable = 'YES' AS nullable, c.column_default, c.ordinal_position
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE' AND c.table_name <> $2
      ORDER BY c.table_name, c.ordinal_position`,
    [schema, HISTORY_TABLE]
  );

  const idx = await db.query(
    `SELECT t.relname AS table_name, i.relname AS index_name,
            pg_get_indexdef(ix.indexrelid) AS def, ix.indisvalid AS valid, ix.indisprimary AS primary
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname <> $2
      ORDER BY 1, 2`,
    [schema, HISTORY_TABLE]
  );

  const cons = await db.query(
    `SELECT t.relname AS table_name, c.conname AS name, c.contype AS type,
            pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname <> $2
      ORDER BY 1, 2`,
    [schema, HISTORY_TABLE]
  );

  const tables = {};
  const table = (n) => (tables[n] ||= { columns: {}, indexes: [], constraints: [] });

  for (const r of cols.rows) {
    table(r.table_name).columns[r.column_name] = {
      type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type,
      nullable: r.nullable,
      default: r.column_default,
    };
  }
  for (const r of idx.rows) {
    table(r.table_name).indexes.push({
      name: r.index_name,
      def: r.def.replace(new RegExp(`\\b${schema}\\.`, 'g'), ''),
      valid: r.valid,
      primary: r.primary,
    });
  }
  for (const r of cons.rows) {
    table(r.table_name).constraints.push({
      name: r.name,
      type: { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check' }[r.type] || r.type,
      def: r.def.replace(new RegExp(`\\b${schema}\\.`, 'g'), ''),
      validated: r.validated,
    });
  }
  return { tables };
}

export async function schemaExists(db, schema) {
  const r = await db.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  return r.rowCount > 0;
}

// Column-only snapshot. Unlike pg_get_indexdef this never waits on table
// locks, so it is safe to call right before a migration.
export async function introspectColumns(db, schema) {
  const r = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name <> $2`,
    [schema, HISTORY_TABLE]
  );
  const tables = {};
  for (const row of r.rows) {
    (tables[row.table_name] ||= { columns: {} }).columns[row.column_name] = {};
  }
  return { tables };
}
