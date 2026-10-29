import { demo } from '../db.js';
import { buildProbes, probeSql } from './health.js';

const SLOW_MS = 250;

// Runs the read queries of every active app version in a loop on its own
// connection while a migration is executing. If a probe errors or is slower
// than SLOW_MS (for example because it is waiting on an ACCESS EXCLUSIVE
// lock), that time counts as measured downtime for the service.
export function startProbe(schema, requirements, existingSchema, intervalMs) {
  const live = requirements.filter((r) => existingSchema?.tables?.[r.table]?.columns?.[r.column]);
  const probes = buildProbes(live);
  const stats = { total: 0, failed: 0, downtimeMs: 0, samples: [] };

  if (!probes.length) {
    return { stats, stop: async () => stats };
  }

  let running = true;
  let client;

  const loop = (async () => {
    client = await demo.connect();
    await client.query('SET statement_timeout = 5000');
    try {
      do {
        for (const p of probes) {
          const t0 = Date.now();
          let ok = true;
          try {
            await client.query(probeSql(schema, p));
          } catch {
            ok = false;
          }
          const ms = Date.now() - t0;
          stats.total++;
          if (!ok || ms > SLOW_MS) {
            stats.failed++;
            stats.downtimeMs += ms;
          }
          if (stats.samples.length < 500) stats.samples.push({ ms, ok });
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      } while (running);
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  })();

  return {
    stats,
    stop: async () => {
      // Let at least one probe run after the migration finishes.
      await new Promise((r) => setTimeout(r, intervalMs));
      running = false;
      await loop.catch(() => {});
      return stats;
    },
  };
}
