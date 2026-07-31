// control-plane/src/routes/decisions.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { apiKeyOnly } from '../middleware/auth.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as decisionIngest from '../domains/decision/decisionIngestService.js';

const router = Router();
router.use(apiKeyOnly);

/**
 * POST /v1/decisions/batch — edge WAL flush (api-key only).
 * Idempotent on (edge_node_id, batch_id) + payload_hash.
 */
router.post(
  '/batch',
  defineHandler({
    async handler(req, res) {
      const tenantId = req.user?.tenantId;
      const apiKeyId = req.user?.apiKeyId;
      if (!tenantId || !apiKeyId) {
        throw new AppError(CODES.FORBIDDEN, 'Tenant API key required');
      }
      const result = await decisionIngest.ingestDecisionBatch({
        tenantId,
        apiKeyId,
        body: req.body as decisionIngest.DecisionBatchWire,
      });
      ok(res, result);
    },
  })
);

export default router;
