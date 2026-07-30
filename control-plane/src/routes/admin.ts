import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireStaff } from '../middleware/requireStaff.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as syncCursorRepo from '../domains/sync/syncCursorRepository.js';

const router = Router();
router.use(authMiddleware);
router.use(requireStaff);

router.get(
  '/sync/lag',
  defineHandler({
    async handler(req, res) {
      // Platform staff: global view. Tenant admin:read API keys: own tenant only.
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

export default router;
