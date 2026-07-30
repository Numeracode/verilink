// control-plane/src/domains/sync/sseSession.ts
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { logger } from '../../shared/logger.js';
import * as syncRepo from './syncRepository.js';
import type { SyncEvent } from './syncRepository.js';
import * as syncCursorRepo from './syncCursorRepository.js';
import {
  SseWriteQueue,
  formatSseComment,
  formatSseEvent,
} from './sseWriteQueue.js';
import { getSseRegistry } from './sseRegistry.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort);
  });
}

function eventFrame(event: SyncEvent): { frame: string; cursor: bigint; size: number } {
  const cursor = BigInt(event.sync_version);
  const frame = formatSseEvent({
    id: cursor,
    event: event.event_type,
    data: JSON.stringify(event.payload),
  });
  return { frame, cursor, size: Buffer.byteLength(frame) };
}

async function enqueueIncremental(
  queue: SseWriteQueue,
  frame: string,
  cursor: bigint | undefined,
  signal: AbortSignal
): Promise<'ok' | 'oversized' | 'closed'> {
  for (;;) {
    if (signal.aborted) return 'closed';
    const result = queue.enqueueData(frame, cursor);
    if (result === 'ok' || result === 'oversized' || result === 'closed') {
      return result;
    }
    const space = await queue.waitForSpace(Buffer.byteLength(frame), signal);
    if (space === 'closed') return 'closed';
  }
}

export async function runSseSession(opts: {
  req: Request;
  res: Response;
  lastEventId: bigint;
  tenantId: string | undefined;
  apiKeyId: string | undefined;
  initialEvents: SyncEvent[];
  initialHighWater: bigint;
}): Promise<void> {
  const { req, res, tenantId, apiKeyId, initialEvents, initialHighWater } = opts;
  const sse = config.syncSse;
  const registry = getSseRegistry();
  const abort = new AbortController();

  req.socket.setNoDelay(true);

  const queue = new SseWriteQueue(res, {
    maxFrames: sse.writeQueueMax,
    maxBytes: sse.writeQueueMaxBytes,
    maxFrameBytes: sse.maxFrameBytes,
    slowClientMs: sse.slowClientMs,
    onSlowClient: () => {
      logger.warn('SSE slow client disconnected');
    },
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let persistTimer: ReturnType<typeof setInterval> | null = null;
  let lastEmittedHw = -1n;
  let durableEventsWritten = 0;
  let edgeNodeId: string | null = null;
  let cleaned = false;

  if (tenantId && apiKeyId) {
    try {
      edgeNodeId = await syncCursorRepo.resolveEdgeNodeForApiKey(tenantId, apiKeyId);
    } catch (err) {
      logger.warn({ err }, 'failed to resolve edge_node for SSE session');
    }
  }

  const persistCursor = async () => {
    if (!tenantId || !edgeNodeId) return;
    const written = queue.writtenCursor;
    if (written === null) return;
    await syncCursorRepo.upsertSyncCursor({
      tenantId,
      edgeNodeId,
      lastCursor: written,
    });
  };

  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    queue.close();
  };

  const conn = registry.tryRegister(queue, abort, cleanup);
  if (!conn) {
    cleanup();
    if (!res.headersSent) {
      res.status(503).json({
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'SSE connection limit reached' },
      });
    } else {
      res.end();
    }
    return;
  }

  const finish = async () => {
    if (cleaned) return;
    cleaned = true;
    abort.abort();
    await persistCursor();
    registry.unregister(conn.id);
    cleanup();
  };

  req.on('close', () => {
    void finish();
  });

  res.write(`retry: ${sse.pollIntervalMs}\n\n`);

  for (const ev of initialEvents) {
    const { frame, cursor, size } = eventFrame(ev);
    if (size > sse.maxFrameBytes) {
      logger.warn({ syncVersion: ev.sync_version }, 'SSE durable frame exceeds max size');
      await finish();
      res.end();
      return;
    }
    const result = await enqueueIncremental(queue, frame, cursor, abort.signal);
    if (result !== 'ok') {
      await finish();
      res.end();
      return;
    }
    durableEventsWritten += 1;
  }

  {
    const frame = formatSseEvent({
      id: initialHighWater,
      event: 'cursor',
      data: '{}',
    });
    const result = await enqueueIncremental(queue, frame, initialHighWater, abort.signal);
    if (result !== 'ok') {
      await finish();
      res.end();
      return;
    }
    lastEmittedHw = initialHighWater;
  }

  heartbeatTimer = setInterval(() => {
    void enqueueIncremental(queue, formatSseComment('ping'), undefined, abort.signal);
  }, sse.heartbeatIntervalMs);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  persistTimer = setInterval(() => {
    void persistCursor();
  }, sse.cursorPersistIntervalMs);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();

  try {
    while (!abort.signal.aborted) {
      await sleep(sse.pollIntervalMs, abort.signal);
      const pollStarted = Date.now();
      const { events, highWater } = await syncRepo.getPollBatchWithHighWater(
        lastEmittedHw,
        tenantId,
        sse.maxInitialBatch
      );
      const pollMs = Date.now() - pollStarted;
      logger.debug(
        {
          sseConn: conn.id,
          pollMs,
          eventCount: events.length,
          highWater: highWater.toString(),
          activeConnections: registry.size,
        },
        'SSE poll cycle'
      );
      for (const ev of events) {
        const { frame, cursor, size } = eventFrame(ev);
        if (size > sse.maxFrameBytes) {
          logger.warn({ syncVersion: ev.sync_version }, 'SSE durable frame exceeds max size');
          queue.enqueueControl(formatSseEvent({ event: 'shutdown', data: '{}' }));
          abort.abort();
          break;
        }
        const result = await enqueueIncremental(queue, frame, cursor, abort.signal);
        if (result !== 'ok') {
          abort.abort();
          break;
        }
        durableEventsWritten += 1;
        if (durableEventsWritten >= sse.cursorPersistEveryEvents) {
          durableEventsWritten = 0;
          await persistCursor();
        }
      }
      if (highWater > lastEmittedHw) {
        const frame = formatSseEvent({
          id: highWater,
          event: 'cursor',
          data: '{}',
        });
        const result = await enqueueIncremental(queue, frame, highWater, abort.signal);
        if (result === 'ok') {
          lastEmittedHw = highWater;
        } else {
          abort.abort();
          break;
        }
      }
    }
  } catch {
    // aborted or disconnect
  } finally {
    await finish();
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}
