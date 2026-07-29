// control-plane/src/domains/sync/sseSession.ts
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { logger } from '../../shared/logger.js';
import * as syncRepo from './syncRepository.js';
import type { SyncEvent } from './syncRepository.js';
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
    // full — wait for space
    const space = await queue.waitForSpace(Buffer.byteLength(frame), signal);
    if (space === 'closed') return 'closed';
  }
}

export async function runSseSession(opts: {
  req: Request;
  res: Response;
  lastEventId: bigint;
  tenantId: string | undefined;
  initialEvents: SyncEvent[];
  initialHighWater: bigint;
}): Promise<void> {
  const { req, res, tenantId, initialEvents, initialHighWater } = opts;
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
  let lastEmittedHw = -1n; // force bootstrap cursor even when hw=0

  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    queue.close();
  };

  const conn = registry.tryRegister(queue, abort, cleanup);
  if (!conn) {
    // Should have been gated before headers; defensive.
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

  const unregister = () => {
    registry.unregister(conn.id);
    cleanup();
  };

  req.on('close', () => {
    abort.abort();
    unregister();
  });

  res.write(`retry: ${sse.pollIntervalMs}\n\n`);

  // Initial batch
  for (const ev of initialEvents) {
    const { frame, cursor, size } = eventFrame(ev);
    if (size > sse.maxFrameBytes) {
      logger.warn({ syncVersion: ev.sync_version }, 'SSE durable frame exceeds max size');
      abort.abort();
      unregister();
      res.end();
      return;
    }
    const result = await enqueueIncremental(queue, frame, cursor, abort.signal);
    if (result !== 'ok') {
      unregister();
      res.end();
      return;
    }
  }

  // Bootstrap cursor (Decision 4)
  {
    const frame = formatSseEvent({
      id: initialHighWater,
      event: 'cursor',
      data: '{}',
    });
    const result = await enqueueIncremental(queue, frame, initialHighWater, abort.signal);
    if (result !== 'ok') {
      unregister();
      res.end();
      return;
    }
    lastEmittedHw = initialHighWater;
  }

  heartbeatTimer = setInterval(() => {
    void enqueueIncremental(queue, formatSseComment('ping'), undefined, abort.signal);
  }, sse.heartbeatIntervalMs);
  // Allow process to exit with open SSE in tests
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

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
    unregister();
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}
