import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

/** Resolve dashboard dist directory; empty string means "do not mount". */
export function resolveDashboardDistPath(): string {
  // Prefer live env so tests can set DASHBOARD_DIST_PATH after config freeze.
  const fromEnv = (process.env.DASHBOARD_DIST_PATH || config.dashboard.distPath || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), '../dashboard/dist');
}

function isSpaBypassPath(reqPath: string): boolean {
  return (
    reqPath === '/healthz' ||
    reqPath.startsWith('/v1/') ||
    reqPath.startsWith('/webhooks/')
  );
}

/**
 * Serve the Vite dashboard build (static assets + SPA fallback).
 * Must be mounted after API routes; never shadows /v1, /webhooks, /healthz.
 * No-ops when index.html is missing (local CP without a dashboard build).
 */
export function mountDashboardSpa(app: Express): void {
  const dist = resolveDashboardDistPath();
  const indexHtml = path.join(dist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    logger.info({ dist }, 'dashboard dist not found; SPA not mounted');
    return;
  }

  app.use(
    express.static(dist, {
      index: false,
      fallthrough: true,
      // Hashed assets can be cached; HTML stays no-store via earlier middleware.
      maxAge: '1h',
    })
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (isSpaBypassPath(req.path)) {
      next();
      return;
    }
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });

  logger.info({ dist }, 'dashboard SPA mounted');
}
