// control-plane/src/routes/decisions.ts
import { Router, type Request } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { apiKeyOnly, authMiddleware } from '../middleware/auth.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as decisionIngest from '../domains/decision/decisionIngestService.js';
import * as decisionRead from '../domains/decision/decisionReadRepository.js';
import { resolveTimeWindow } from '../lib/timeWindow.js';

const router = Router();

function requireTenant(req: Request): string {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    throw new AppError(CODES.FORBIDDEN, 'Tenant required');
  }
  return tenantId;
}

/**
 * POST /v1/decisions/batch — edge WAL flush (api-key only).
 * Idempotent on (edge_node_id, batch_id) + payload_hash.
 */
router.post(
  '/batch',
  apiKeyOnly,
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

/**
 * GET /v1/decisions/aggregates?from=&to=&dimension= — per-minute rollups.
 * Window defaults to the last 24h and is capped at 31d.
 */
router.get(
  '/aggregates',
  authMiddleware,
  defineHandler({
    query: {
      from: { type: 'string', required: false },
      to: { type: 'string', required: false },
      dimension: {
        type: 'string',
        required: false,
        enum: ['all', 'principal', 'fingerprint'] as const,
      },
    },
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const { from, to } = resolveTimeWindow(req.query.from, req.query.to);
      const dimension = (req.query.dimension as decisionRead.DecisionDimension) || 'all';
      const items = await decisionRead.getAggregates({ tenantId, from, to, dimension });
      ok(res, { from, to, dimension, items });
    },
  })
);

/** GET /v1/decisions/samples?from=&to=&limit= — sampled decision feed. */
router.get(
  '/samples',
  authMiddleware,
  defineHandler({
    query: {
      from: { type: 'string', required: false },
      to: { type: 'string', required: false },
      limit: { type: 'number', min: 1, max: 500, required: false },
    },
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const { from, to } = resolveTimeWindow(req.query.from, req.query.to);
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const items = await decisionRead.getSamples({ tenantId, from, to, limit });
      ok(res, { from, to, items });
    },
  })
);

/**
 * GET /v1/decisions/agents?from=&to=&limit= — provider agent list: distinct
 * principals in the tenant's sampled decisions with current network scores.
 */
router.get(
  '/agents',
  authMiddleware,
  defineHandler({
    query: {
      from: { type: 'string', required: false },
      to: { type: 'string', required: false },
      limit: { type: 'number', min: 1, max: 500, required: false },
    },
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const { from, to } = resolveTimeWindow(req.query.from, req.query.to);
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const items = await decisionRead.listAgents({ tenantId, from, to, limit });
      ok(res, { from, to, items });
    },
  })
);

export default router;
