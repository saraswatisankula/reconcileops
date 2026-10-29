import { z } from 'zod';
import { q } from '../db.js';

export const settingsSchema = z.object({
  auto_rollback: z.boolean(),
  max_retries: z.number().int().min(0).max(5),
  retry_backoff_ms: z.number().int().min(50).max(10000),
  lock_timeout_ms: z.number().int().min(100).max(60000),
  statement_timeout_ms: z.number().int().min(1000).max(600000),
  probe_interval_ms: z.number().int().min(20).max(2000),
  enforce_promotion_order: z.boolean(),
});

export const DEFAULTS = {
  auto_rollback: true,
  max_retries: 2,
  retry_backoff_ms: 400,
  lock_timeout_ms: 3000,
  statement_timeout_ms: 30000,
  probe_interval_ms: 50,
  enforce_promotion_order: true,
};

export async function getSettings() {
  const rows = await q('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) {
    if (r.key in out) out[r.key] = r.value;
  }
  return out;
}

export async function updateSettings(patch) {
  const merged = settingsSchema.parse({ ...(await getSettings()), ...patch });
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    await q(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(merged[key])]
    );
  }
  return merged;
}
