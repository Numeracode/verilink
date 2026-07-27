import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { apiKeyOnly } from '../middleware/auth.js';
import * as syncService from '../domains/sync/syncService.js';

const router = Router();
router.use(apiKeyOnly);

router.get('/snapshot', defineHandler({
  async handler(req, res) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Tenant required' } });
    }
    const snapshot = await syncService.getSnapshot(tenantId);
    ok(res, snapshot);
  },
}));

router.get('/events', defineHandler({
  query: {
    last_event_id: { type: 'number' },
  },
  async handler(req, res) {
    const sinceVersion = req.query.last_event_id
      ? parseInt(req.query.last_event_id as string, 10)
      : 0;
    const tenantId = req.user?.tenantId || undefined;
    const events = await syncService.getEventsSince(sinceVersion, tenantId);

    // SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    for (const event of events) {
      res.write(`id: ${event.sync_version}\n`);
      res.write(`event: ${event.event_type}\n`);
      res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
    }

    // Send cursor event for the high water mark
    const hw = await syncService.getEventsSince(0); // get max version
    // Actually, we need getHighWaterVersion
    // For now, just end the stream
    res.end();
  },
}));

export default router;
