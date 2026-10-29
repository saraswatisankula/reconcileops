import { q } from '../db.js';
import { logger } from '../logger.js';

export async function audit(action, entity, entityId, details = {}, actor = 'operator') {
  try {
    await q(
      `INSERT INTO audit_logs (actor, action, entity, entity_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actor, action, entity, entityId ?? null, JSON.stringify(details)]
    );
  } catch (err) {
    // An audit failure should be visible but must not hide the original result.
    logger.error({ err, action }, 'failed to write audit log');
  }
}
