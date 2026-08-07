import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

const DISABLE_TOKENS = new Set(['off', 'false', '0', '-', 'disabled']);

/** Repo `dashboard/dist` relative to this module (control-plane/src/dashboard/). */
const MODULE_DASHBOARD_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../dashboard/dist'
);

/**
 * Resolve dashboard dist directory.
 * Returns null when SPA mounting is explicitly disabled
 * (`DASHBOARD_DIST_PATH` / config = off|false|0|-|disabled).
 * When unset, uses the monorepo `dashboard/dist` next to `control-plane/`
 * (stable regardless of process cwd).
 */
export function resolveDashboardDistPath(): string | null {
  // Prefer live env so tests can set DASHBOARD_DIST_PATH after config freeze.
  const raw = (process.env.DASHBOARD_DIST_PATH || config.dashboard.distPath || '').trim();
  if (raw && DISABLE_TOKENS.has(raw.toLowerCase())) {
    return null;
  }
  if (raw) return path.resolve(raw);
  return MODULE_DASHBOARD_DIST;
}

/** True for API / health / webhook paths that must never receive SPA HTML. */
export function isSpaBypassPath(reqPath: string): boolean {
  return (
    reqPath === '/healthz' ||
    reqPath === '/v1' ||
    reqPath.startsWith('/v1/') ||
    reqPath === '/webhooks' ||
    reqPath.startsWith('/webhooks/')
  );
}

/**
 * Serve the Vite dashboard build (static assets + SPA fallback).
 * Must be mounted after API routes; never shadows /v1, /webhooks, /healthz.
 * No-ops when disabled or when index.html is missing.
 */
export function mountDashboardSpa(app: Express): void {
  const dist = resolveDashboardDistPath();
  if (dist === null) {
    logger.info('dashboard SPA mounting disabled via DASHBOARD_DIST_PATH');
    return;
  }
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
