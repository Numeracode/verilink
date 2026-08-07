// control-plane/src/routes/scores.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import * as scoreRead from '../domains/score/scoreReadRepository.js';

const router = Router();
router.use(authMiddleware);

/**
 * GET /v1/scores/:principalId/history — current score + change history from
 * network_score_history. Scores are global (shared graph); any authenticated
 * caller may read them.
 */
router.get(
  '/:principalId/history',
  defineHandler({
    params: { principalId: { type: 'string' } },
    query: { limit: { type: 'number', min: 1, max: 1000, required: false } },
    async handler(req, res) {
      const principalId = req.params.principalId as string;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const [current, items] = await Promise.all([
        scoreRead.getCurrentScore(principalId),
        scoreRead.getScoreHistory(principalId, limit),
      ]);
      ok(res, { principal_id: principalId, current, items });
    },
  })
);

export default router;
