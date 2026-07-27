// control-plane/src/middleware/requestTracker.ts
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export function requestTracker(req: Request, res: Response, next: NextFunction) {
  req.requestId = req.requestId || randomUUID();
  req.correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Correlation-Id', req.correlationId);
  next();
}

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      correlationId: string;
    }
  }
}
