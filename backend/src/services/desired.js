import crypto from 'node:crypto';
import { demo, ident } from '../db.js';
import { introspect } from './introspect.js';

// Builds the schema that a list of scripts *should* produce by replaying them
// in a throwaway schema inside a transaction that is always rolled back.
// Nothing is left behind in the demo database.
export async function buildDesired(scripts) {
  const scratch = 'rops_scratch_' + crypto.randomBytes(4).toString('hex');
  const client = await demo.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${ident(scratch)}`);
    await client.query(`SET LOCAL search_path TO ${ident(scratch)}`);
    await client.query(`SET LOCAL statement_timeout = 15000`);

    for (const s of scripts) {
      // CONCURRENTLY is not allowed inside a transaction; for a structural
      // replay the plain form produces the same end result.
      const sql = s.up_sql.replace(/\bCONCURRENTLY\b/gi, '');
      try {
        await client.query('SAVEPOINT step');
        await client.query(sql);
        await client.query('RELEASE SAVEPOINT step');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT step');
        const schema = await introspect(client, scratch);
        return { schema, failedAt: s.version, error: err.message };
      }
    }
    const schema = await introspect(client, scratch);
    return { schema, failedAt: null, error: null };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
