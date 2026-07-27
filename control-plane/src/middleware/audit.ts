// control-plane/src/middleware/audit.ts
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/client.js';
import { logger } from '../shared/logger.js';

export async function auditLog(
  userId: string | undefined,
  action: string,
  resource: string,
  resourceId: string | undefined,
  req: Request,
  metadata?: Record<string, unknown>
) {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return; // no tenant context, skip

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, resource, resource_id, metadata, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        req.user?.type || 'unknown',
        userId || req.user?.userId || req.user?.apiKeyId || null,
        action,
        resource,
        resourceId || null,
        metadata ? JSON.stringify(metadata) : '{}',
        req.ip,
        req.headers['user-agent'] || null,
      ]
    );
  } catch (err) {
    // Audit failure never blocks the main request
    logger.error({ err }, 'Audit log write failed');
  }
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Only log mutations (not GETs)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      auditLog(
        req.user?.userId,
        `${req.method} ${req.path}`,
        req.path,
        undefined,
        req,
        { status: res.statusCode, duration }
      );
    }
  });
  next();
}
