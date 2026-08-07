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
import adminRouter from './routes/admin.js';
import decisionsRouter from './routes/decisions.js';
import policiesRouter from './routes/policies.js';
import scoresRouter from './routes/scores.js';
import graphRouter from './routes/graph.js';
import edgeNodesRouter from './routes/edgeNodes.js';
import apiKeysRouter from './routes/apiKeys.js';
import billingRouter from './routes/billing.js';
import tenantsRouter from './routes/tenants.js';
import webhookStripeRouter from './routes/webhookStripe.js';
import { mountDashboardSpa } from './dashboard/spaServe.js';

export function createApp() {
  const app = express();

  // Middleware stack (order matters)
  app.use(requestTracker);
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(pinoHttp({ logger, autoLogging: false }));

  // Stripe webhook: raw body (before json) + exempt from the rate limiter/audit
  // middleware, which apply only to user-facing routes below.
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use('/webhooks/stripe', webhookStripeRouter);

  app.use(apiLimiter);
  app.use(auditMiddleware);
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
  app.use('/v1/admin', adminRouter);
  app.use('/v1/decisions', decisionsRouter);
  app.use('/v1/policies', policiesRouter);
  app.use('/v1/scores', scoresRouter);
  app.use('/v1/graph', graphRouter);
  app.use('/v1/edge-nodes', edgeNodesRouter);
  app.use('/v1/api-keys', apiKeysRouter);
  app.use('/v1/billing', billingRouter);
  app.use('/v1/tenants', tenantsRouter);

  // Dashboard SPA (after API routes; skips /v1, /webhooks, /healthz)
  mountDashboardSpa(app);

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
