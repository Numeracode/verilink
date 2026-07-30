import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireStaff } from '../middleware/requireStaff.js';
import * as syncCursorRepo from '../domains/sync/syncCursorRepository.js';

const router = Router();
router.use(authMiddleware);
router.use(requireStaff);

router.get(
  '/sync/lag',
  defineHandler({
    async handler(_req, res) {
      const rows = await syncCursorRepo.listSyncLag();
      ok(res, { edges: rows });
    },
  })
);

export default router;
