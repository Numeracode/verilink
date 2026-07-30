import { Router } from 'express';
import compression from 'compression';
import type { Request, Response, NextFunction } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { apiKeyOnly } from '../middleware/auth.js';
import * as syncService from '../domains/sync/syncService.js';
import * as syncRepo from '../domains/sync/syncRepository.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import { config } from '../config.js';
import { parseLastEventId } from '../domains/sync/parseLastEventId.js';
import { getSseRegistry } from '../domains/sync/sseRegistry.js';
import { runSseSession } from '../domains/sync/sseSession.js';

const router = Router();
router.use(apiKeyOnly);

/** Snapshot-only gzip; SSE route is not wrapped (Decision 9). */
const snapshotCompression = compression();

router.get(
  '/snapshot',
  snapshotCompression,
  defineHandler({
    async handler(req, res) {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        throw new AppError(CODES.FORBIDDEN, 'Tenant required');
      }
      const snapshot = await syncService.getSnapshot(tenantId);
      ok(res, snapshot);
    },
  })
);

function sendProblem(
  res: Response,
  status: number,
  code: string,
  message: string,
  extras?: Record<string, string>
): void {
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      res.setHeader(k, v);
    }
  }
  res.status(status).type('application/problem+json').json({
    type: `https://verilink.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title: message,
    status,
    code,
  });
}

router.get('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const registry = getSseRegistry();
    if (!registry.isAccepting || registry.size >= config.syncSse.maxConnections) {
      sendProblem(res, 503, 'SERVICE_UNAVAILABLE', 'SSE connection limit reached');
      return;
    }

    const headerRaw = req.headers['last-event-id'];
    const headerPresent = Object.prototype.hasOwnProperty.call(req.headers, 'last-event-id');
    const queryKeyPresent = Object.prototype.hasOwnProperty.call(req.query, 'last_event_id');
    const queryRaw = req.query.last_event_id as string | string[] | undefined;

    const parsed = parseLastEventId({
      header: headerRaw,
      headerPresent,
      query: queryRaw,
      queryKeyPresent,
    });
    if (!parsed.ok) {
      throw new AppError(CODES.BAD_REQUEST, parsed.message);
    }

    const tenantId = req.user?.tenantId || undefined;
    const batch = await syncRepo.getInitialBatchWithHighWater(
      parsed.value,
      tenantId,
      config.syncSse.maxInitialBatch
    );

    if (batch.backlogExceeded) {
      sendProblem(res, 429, 'RATE_LIMITED', 'Sync backlog exceeds initial batch cap', {
        'X-Verilink-Sync-Reason': 'backlog-cap',
      });
      return;
    }

    // Check again before opening stream (admission)
    if (!registry.isAccepting || registry.size >= config.syncSse.maxConnections) {
      sendProblem(res, 503, 'SERVICE_UNAVAILABLE', 'SSE connection limit reached');
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    await runSseSession({
      req,
      res,
      lastEventId: parsed.value,
      tenantId,
      apiKeyId: req.user?.apiKeyId,
      initialEvents: batch.events,
      initialHighWater: batch.highWater,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
