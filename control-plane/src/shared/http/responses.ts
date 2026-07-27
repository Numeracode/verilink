// control-plane/src/shared/http/responses.ts
import type { Response } from 'express';
import { AppError, CODES } from '../errors/AppError.js';
import { logger } from '../logger.js';

export function ok(res: Response, data: unknown) {
  return res.status(200).json({ ok: true, data });
}

export function created(res: Response, data: unknown, locationUrl?: string) {
  if (locationUrl) res.setHeader('Location', locationUrl);
  return res.status(201).json({ ok: true, data });
}

export function accepted(res: Response, data: unknown) {
  return res.status(202).json({ ok: true, data });
}

export function noContent(res: Response) {
  return res.status(204).end();
}

export function paginated(
  res: Response,
  { items, total, limit, offset }: { items: unknown[]; total: number; limit: number; offset: number }
) {
  return res.status(200).json({
    ok: true,
    data: { items, total, limit, offset },
  });
}

export function error(res: Response, err: unknown) {
  const appErr = AppError.from(err);
  logger.error({ err: appErr, code: appErr.code }, appErr.message);
  return res.status(appErr.status).json(appErr.toResponse());
}