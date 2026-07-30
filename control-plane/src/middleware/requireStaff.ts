// control-plane/src/middleware/requireStaff.ts
import type { Request, Response, NextFunction } from 'express';
import { AppError, CODES } from '../shared/errors/AppError.js';

/**
 * Platform staff (OIDC isStaff) or API key with admin:read scope.
 */
export function requireStaff(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.isStaff) {
    next();
    return;
  }
  if (req.user?.type === 'apikey' && (req.user.scopes || []).includes('admin:read')) {
    next();
    return;
  }
  next(new AppError(CODES.FORBIDDEN, 'Staff access required'));
}
