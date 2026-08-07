// control-plane/src/routes/apiKeys.ts
import { Router } from 'express';
import { ok, created } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as apiKeyRepo from '../domains/apikey/apiKeyRepository.js';

const router = Router();
router.use(authMiddleware);

const ALLOWED_SCOPES = [
  'attest:read',
  'attest:write',
  'admin:read',
  'policy:read',
  'policy:admin',
  '*',
] as const;

function requireTenant(req: { user?: { tenantId?: string | null } }): string {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new AppError(CODES.FORBIDDEN, 'Tenant required');
  return tenantId;
}

function parseScopes(body: unknown): string[] {
  const raw = (body as { scopes?: unknown } | null)?.scopes ?? [];
  if (!Array.isArray(raw)) {
    throw new AppError(CODES.BAD_REQUEST, 'scopes must be an array');
  }
  if (raw.length > 16) {
    throw new AppError(CODES.BAD_REQUEST, 'scopes may not exceed 16 entries');
  }
  const scopes: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new AppError(CODES.BAD_REQUEST, 'scopes entries must be non-empty strings');
    }
    if (!ALLOWED_SCOPES.includes(s as (typeof ALLOWED_SCOPES)[number])) {
      throw new AppError(
        CODES.BAD_REQUEST,
        `unknown scope "${s}"; allowed: ${ALLOWED_SCOPES.join(', ')}`
      );
    }
    if (!scopes.includes(s)) scopes.push(s);
  }
  return scopes;
}

/** GET /v1/api-keys — list the caller tenant's API keys (no secrets). */
router.get(
  '/',
  defineHandler({
    async handler(req, res) {
      const tenantId = requireTenant(req);
      ok(res, { items: await apiKeyRepo.listApiKeys(tenantId) });
    },
  })
);

/**
 * POST /v1/api-keys — mint a tenant API key. The secret is returned exactly
 * once in the response; only the HMAC hash + prefix are persisted.
 */
router.post(
  '/',
  defineHandler({
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const scopes = parseScopes(req.body);
      const key = await apiKeyRepo.createApiKey(tenantId, scopes);
      created(res, key, `/v1/api-keys/${key.id}`);
    },
  })
);

/** DELETE /v1/api-keys/:id — revoke (soft delete) a tenant API key. */
router.delete(
  '/:id',
  defineHandler({
    params: { id: { type: 'uuid' } },
    async handler(req, res) {
      const tenantId = requireTenant(req);
      await apiKeyRepo.revokeApiKey(tenantId, req.params.id as string);
      res.status(204).end();
    },
  })
);

export default router;
