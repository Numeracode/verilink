// control-plane/src/routes/admin.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireStaff } from '../middleware/requireStaff.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as syncCursorRepo from '../domains/sync/syncCursorRepository.js';
import * as bootstrapRepo from '../domains/bootstrap/bootstrapRepository.js';

const router = Router();
router.use(authMiddleware);
router.use(requireStaff);

router.get(
  '/sync/lag',
  defineHandler({
    async handler(req, res) {
      const tenantId = req.user?.tenantId ?? undefined;
      const scopeTenantId = req.user?.isStaff ? undefined : tenantId;
      if (!req.user?.isStaff && !scopeTenantId) {
        throw new AppError(CODES.FORBIDDEN, 'Tenant required');
      }
      const rows = await syncCursorRepo.listSyncLag(scopeTenantId);
      ok(res, { edges: rows });
    },
  })
);

/** GET /v1/admin/bootstrap-issuers — read the bootstrap registry. */
router.get(
  '/bootstrap-issuers',
  defineHandler({
    async handler(_req, res) {
      ok(res, { items: await bootstrapRepo.listBootstrapIssuers() });
    },
  })
);

/**
 * PATCH /v1/admin/bootstrap-issuers — edit a bootstrap issuer's Root.weight
 * (de-emphasis) + reason. Staff-only; full cold-start seed remains Plan 14.
 */
router.patch(
  '/bootstrap-issuers',
  defineHandler({
    async handler(req, res) {
      const body = req.body as {
        principal_id?: string;
        current_weight?: number;
        de_emphasis_reason?: string | null;
      };
      if (!body.principal_id || typeof body.principal_id !== 'string') {
        throw new AppError(CODES.BAD_REQUEST, 'principal_id is required');
      }
      const update: bootstrapRepo.BootstrapUpdate = {};
      if (body.current_weight !== undefined) {
        if (
          typeof body.current_weight !== 'number' ||
          Number.isNaN(body.current_weight) ||
          body.current_weight < 0 ||
          body.current_weight > 1
        ) {
          throw new AppError(CODES.BAD_REQUEST, 'current_weight must be a number between 0 and 1');
        }
        update.current_weight = body.current_weight;
      }
      if (body.de_emphasis_reason !== undefined) {
        if (body.de_emphasis_reason !== null && typeof body.de_emphasis_reason !== 'string') {
          throw new AppError(CODES.BAD_REQUEST, 'de_emphasis_reason must be a string or null');
        }
        update.de_emphasis_reason = body.de_emphasis_reason;
      }
      update.approved_by = req.user?.userId ?? null;

      const updated = await bootstrapRepo.updateBootstrapIssuer(body.principal_id, update);
      if (!updated) {
        throw new AppError(CODES.NOT_FOUND, 'Bootstrap issuer not found');
      }
      ok(res, { issuer: updated });
    },
  })
);

/** GET /v1/admin/issuers/unverified — issuer verification queue. */
router.get(
  '/issuers/unverified',
  defineHandler({
    async handler(_req, res) {
      ok(res, { items: await bootstrapRepo.listUnverifiedIssuers() });
    },
  })
);

export default router;
