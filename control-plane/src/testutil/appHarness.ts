import { createServer, type Server } from 'node:http';
import type { Express } from 'express';

export interface ControlPlaneHarness {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Starts the Express control plane on an ephemeral port.
 * Must be called after DATABASE_URL / API_KEY_HMAC_SECRET are set so
 * config + pool pick up the test database.
 */
export async function startControlPlane(
  _trustEngineAddr?: string
): Promise<ControlPlaneHarness> {
  // Dynamic import so config freezes after env is configured by the caller.
  const { createApp } = await import('../app.js');
  const { pool, recreatePool } = await import('../db/client.js');
  // Prior suite may have ended the singleton pool in stop().
  if (pool.ended) {
    recreatePool();
  }
  const app: Express = createApp();

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      // End the singleton app pool so node:test can exit cleanly.
      const { pool: livePool } = await import('../db/client.js');
      if (!livePool.ended) {
        await livePool.end();
      }
    },
  };
}
