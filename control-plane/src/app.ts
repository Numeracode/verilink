import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { logger } from './shared/logger.js';
import { requestTracker } from './middleware/requestTracker.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { auditMiddleware } from './middleware/audit.js';
import { error } from './shared/http/responses.js';
import { AppError, CODES } from './shared/errors/AppError.js';

import principalsRouter from './routes/principals.js';
import attestationsRouter from './routes/attestations.js';
import syncRouter from './routes/sync.js';

export function createApp() {
  const app = express();

  // Middleware stack (order matters)
  app.use(requestTracker);
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(pinoHttp({ logger, autoLogging: false }));
  app.use(apiLimiter);
  app.use(auditMiddleware);

  // Stripe webhook needs raw body (before json parser)
  // app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Health check
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Routes
  app.use('/v1/principals', principalsRouter);
  app.use('/v1/attestations', attestationsRouter);
  app.use('/v1/sync', syncRouter);
  // Additional routes added in later plans:
  // app.use('/v1/policies', policiesRouter);
  // app.use('/v1/api-keys', apikeysRouter);
  // app.use('/v1/edge-nodes', edgenodesRouter);
  // app.use('/v1/tenants', tenantsRouter);

  // 404 catch-all
  app.use((_req, res) => {
    error(res, new AppError(CODES.NOT_FOUND, 'Route not found'));
  });

  // Global error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    error(res, err);
  });

  return app;
}
