// control-plane/src/middleware/requireScope.ts
import type { Request, Response, NextFunction } from 'express';
import { AppError, CODES } from '../shared/errors/AppError.js';

export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(CODES.UNAUTHORIZED, 'Authentication required'));
    }

    if (req.user.type === 'apikey') {
      const scopes = req.user.scopes || [];
      if (!scopes.includes(scope) && !scopes.includes('*')) {
        return next(new AppError(CODES.FORBIDDEN, `Missing required scope: ${scope}`));
      }
    }

    // OIDC users: check role-based access (staff/admin have all scopes)
    if (req.user.type === 'oidc') {
      const role = req.user.role || 'member';
      if (role !== 'staff' && role !== 'admin') {
        // Members need explicit role mapping; for v1, deny by default
        return next(new AppError(CODES.FORBIDDEN, `Role '${role}' does not have scope: ${scope}`));
      }
    }

    next();
  };
}