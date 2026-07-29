import { config, assertDatabaseConfigured, assertSecretsConfigured } from './config.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';
import { logger } from './shared/logger.js';
import { getRecomputeScheduler } from './domains/graph/recomputeScheduler.js';
import { getSseRegistry } from './domains/sync/sseRegistry.js';

async function main() {
  // Validate config
  assertDatabaseConfigured();
  assertSecretsConfigured();

  // Run migrations
  logger.info('Running migrations...');
  await runMigrations();

  const scheduler = getRecomputeScheduler();
  scheduler.start();
  logger.info(
    {
      debounceMs: config.scoreRecompute.debounceMs,
      intervalMs: config.scoreRecompute.intervalMs,
    },
    'Score recompute scheduler started'
  );

  // Create and start server
  const app = createApp();
  const server = app.listen(config.server.port, () => {
    logger.info(`VeriLink control-plane listening on :${config.server.port}`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    // Arm the watchdog before awaiting drains (gRPC / lock / SSE can stall).
    const forceExit = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
    try {
      await getSseRegistry().shutdownAll(config.syncSse.shutdownDrainMs);
    } catch (err) {
      logger.error({ err }, 'SSE shutdown failed');
    }
    try {
      await scheduler.stop();
    } catch (err) {
      logger.error({ err }, 'score recompute scheduler stop failed');
    }
    server.close(async () => {
      await pool.end();
      clearTimeout(forceExit);
      logger.info('Bye.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});
