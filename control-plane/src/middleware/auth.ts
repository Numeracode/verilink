// control-plane/src/middleware/auth.ts
import type { Request, Response, NextFunction } from 'express';
import { createHmac } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, CODES } from '../shared/errors/AppError.js';
import { config } from '../config.js';
import { pool } from '../db/client.js';

// Clerk JWKS endpoint (fetched once, cached by openid-client)
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks && config.auth.clerkIssuerUrl) {
    const discoveryUrl = `${config.auth.clerkIssuerUrl}/.well-known/openid-configuration`;
    // We'll fetch the JWKS URL from discovery in a real implementation;
    // for now, Clerk's standard JWKS endpoint pattern.
    const jwksUrl = new URL(`${config.auth.clerkIssuerUrl}/.well-known/jwks.json`);
    jwks = createRemoteJWKSet(jwksUrl);
  }
  return jwks;
}

function hashApiKey(key: string): string {
  return createHmac('sha256', config.apiKey.hmacSecret || '')
    .update(key)
    .digest('hex');
}

/**
 * Dual auth middleware: tries Clerk OIDC first, falls back to API key.
 * Sets req.user with { userId, tenantId, role } or { apiKeyId, tenantId, scopes }.
 */
export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    // Try Bearer token (Clerk OIDC)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Check if it looks like a VeriLink API key
      if (token.startsWith('vrl_')) {
        return await authenticateApiKey(token, req, next);
      }

      // Otherwise try OIDC
      return await authenticateOidc(token, req, next);
    }

    // Try X-API-Key header
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey) {
      return await authenticateApiKey(apiKey, req, next);
    }

    next(new AppError(CODES.UNAUTHORIZED, 'Missing authentication'));
  } catch (err) {
    next(AppError.from(err));
  }
}

async function authenticateApiKey(key: string, req: Request, next: NextFunction) {
  if (!key.startsWith('vrl_') || key.length !== 68) { // vrl_ + 64 chars
    throw new AppError(CODES.UNAUTHORIZED, 'Invalid API key format');
  }

  const prefix = key.slice(0, 7); // vrl_ + first 3 hex chars
  const hash = hashApiKey(key);

  const { rows } = await pool.query(
    `SELECT ak.id, ak.tenant_id, ak.scopes, t.status as tenant_status
     FROM api_keys ak
     JOIN tenants t ON t.id = ak.tenant_id
     WHERE ak.key_prefix = $1 AND ak.key_hash_hmac = $2 AND ak.revoked_at IS NULL`,
    [prefix, hash]
  );

  if (rows.length === 0) {
    throw new AppError(CODES.UNAUTHORIZED, 'Invalid API key');
  }

  const row = rows[0];
  if (row.tenant_status !== 'active') {
    throw new AppError(CODES.FORBIDDEN, 'Tenant is not active');
  }

  req.user = {
    type: 'apikey',
    apiKeyId: row.id,
    tenantId: row.tenant_id,
    scopes: row.scopes,
  };

  // Update last_used_at (fire and forget)
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});

  next();
}

async function authenticateOidc(token: string, req: Request, next: NextFunction) {
  const jwks = getJwks();
  if (!jwks) {
    throw new AppError(CODES.UNAUTHORIZED, 'OIDC not configured');
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.auth.clerkIssuerUrl,
    audience: config.auth.clerkClientId,
  });

  // Find or create user
  const oidcSubject = payload.sub!;
  const oidcIssuer = payload.iss!;

  const { rows } = await pool.query(
    `INSERT INTO users (email, oidc_issuer, oidc_subject)
     VALUES ($1, $2, $3)
     ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, platform_role`,
    [payload.email || `${oidcSubject}@placeholder`, oidcIssuer, oidcSubject]
  );

  const userId = rows[0].id;
  const platformRole = rows[0].platform_role || 'member';

  // Get all tenant memberships (user may belong to multiple tenants)
  const { rows: memberships } = await pool.query(
    `SELECT tenant_id, role FROM tenant_memberships WHERE user_id = $1 ORDER BY tenant_id`,
    [userId]
  );

  req.user = {
    type: 'oidc',
    userId,
    tenantId: memberships[0]?.tenant_id || null,
    role: memberships[0]?.role || 'member',
    tenantIds: memberships.map((m: { tenant_id: string }) => m.tenant_id),
    roles: memberships.map((m: { role: string }) => m.role),
    isStaff: platformRole === 'staff' || platformRole === 'admin',
  };

  next();
}

/**
 * Standalone API key middleware (no OIDC fallback).
 */
export async function apiKeyOnly(req: Request, res: Response, next: NextFunction) {
  const apiKey = (req.headers['x-api-key'] as string) || extractBearerKey(req);
  if (!apiKey) {
    return next(new AppError(CODES.UNAUTHORIZED, 'API key required'));
  }
  try {
    await authenticateApiKey(apiKey, req, next);
  } catch (err) {
    next(AppError.from(err));
  }
}

function extractBearerKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && auth.slice(7).startsWith('vrl_')) {
    return auth.slice(7);
  }
  return null;
}

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        type: 'oidc' | 'apikey';
        userId?: string;
        apiKeyId?: string;
        tenantId?: string | null;
        role?: string;
        scopes?: string[];
        tenantIds?: string[];
        roles?: string[];
        isStaff?: boolean;
      };
    }
  }
}
