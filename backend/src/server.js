import { createApp } from './app.js';
import { config } from './config.js';
import { closePools, q } from './db.js';
import { logger } from './logger.js';

async function start() {
  // Runs left in "running" by a crash or restart are closed off so the
  // concurrency guard doesn't block that project forever.
  try {
    const stale = await q(
      `UPDATE migration_runs
          SET status = 'failed', finished_at = now(), needs_manual = TRUE,
              error_message = 'Interrupted: server restarted while migration was running'
        WHERE status = 'running' RETURNING id`
    );
    if (stale.length) logger.warn({ ids: stale.map((r) => r.id) }, 'closed interrupted runs');
  } catch (err) {
    logger.error({ err }, 'cannot reach metadata database. Did the Flyway migration run?');
    process.exit(1);
  }

  const server = createApp().listen(config.PORT, () => {
    logger.info(`ReconcileOps API listening on :${config.PORT}`);
  });

  const shutdown = () => {
    logger.info('shutting down');
    server.close(async () => {
      await closePools();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
