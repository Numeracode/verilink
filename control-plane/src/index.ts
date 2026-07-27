import { config, assertDatabaseConfigured, assertSecretsConfigured } from './config.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';
import { logger } from './shared/logger.js';

async function main() {
  // Validate config
  assertDatabaseConfigured();
  assertSecretsConfigured();

  // Run migrations
  logger.info('Running migrations...');
  await runMigrations();

  // Create and start server
  const app = createApp();
  const server = app.listen(config.server.port, () => {
    logger.info(`VeriLink control-plane listening on :${config.server.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    server.close(async () => {
      await pool.end();
      logger.info('Bye.');
      process.exit(0);
    });

    // Force close after 10s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});
