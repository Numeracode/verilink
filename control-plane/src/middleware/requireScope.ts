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
      return next();
    }

    // OIDC users: platform staff/admin bypass all scope checks
    if (req.user.isStaff) {
      return next();
    }

    // Tenant-scoped roles: check if ANY membership has a role that
    // grants the scope. Tenant admin/staff can read/write attestations
    // within their tenant; members are denied by default.
    const roles = req.user.roles || [];
    const hasElevatedRole = roles.some(
      (r) => r === 'staff' || r === 'admin'
    );

    if (!hasElevatedRole) {
      return next(new AppError(CODES.FORBIDDEN, `No membership grants scope: ${scope}`));
    }

    next();
  };
}