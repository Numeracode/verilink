// control-plane/src/routes/graph.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import * as scoreRead from '../domains/score/scoreReadRepository.js';

const router = Router();
router.use(authMiddleware);

/**
 * GET /v1/graph/summary — global graph health: node/edge counts, top issuers
 * by outgoing attestation volume (read-only), and the latest score write time
 * (drives the dashboard "scores may be stale" banner, Plan 9 Decision 8).
 * The graph is shared: any authenticated caller may read this.
 */
router.get(
  '/summary',
  defineHandler({
    async handler(_req, res) {
      ok(res, await scoreRead.getGraphSummary());
    },
  })
);

export default router;
