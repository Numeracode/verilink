// control-plane/src/routes/edgeNodes.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as edgeNodeRepo from '../domains/edgenode/edgeNodeRepository.js';

const router = Router();
router.use(authMiddleware);

/**
 * GET /v1/edge-nodes — caller tenant's edge fleet with sync lag fields.
 * (Platform staff global lag remains at /v1/admin/sync/lag.)
 */
router.get(
  '/',
  defineHandler({
    async handler(req, res) {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        throw new AppError(CODES.FORBIDDEN, 'Tenant required');
      }
      const items = await edgeNodeRepo.listEdgeNodesForTenant(tenantId);
      ok(res, { items });
    },
  })
);

export default router;
