import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { SseRegistry } from './sseRegistry.js';
import { SseWriteQueue, formatSseEvent } from './sseWriteQueue.js';

function mockRes(): Response & EventEmitter & { chunks: string[] } {
  const ee = new EventEmitter() as Response & EventEmitter & { chunks: string[] };
  ee.chunks = [];
  (ee as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    ee.chunks.push(c);
    return true;
  };
  (ee as unknown as { end: () => void }).end = () => {};
  (ee as unknown as { on: typeof ee.on }).on = ee.on.bind(ee);
  return ee;
}

describe('SseRegistry', () => {
  it('stops accepting after stopAccepting', () => {
    const reg = new SseRegistry();
    const res = mockRes();
    const q = new SseWriteQueue(res, {
      maxFrames: 10,
      maxBytes: 1000,
      maxFrameBytes: 100,
      slowClientMs: 1000,
    });
    const abort = new AbortController();
    const c = reg.tryRegister(q, abort, () => {});
    assert.ok(c);
    reg.stopAccepting();
    assert.equal(reg.tryRegister(q, abort, () => {}), null);
    reg.unregister(c!.id);
    q.close();
  });

  it('shutdownAll delivers named shutdown event when data queue full', async () => {
    const reg = new SseRegistry();
    const res = mockRes();
    const chunks: string[] = [];
    (res as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      chunks.push(c);
      return true;
    };
    const q = new SseWriteQueue(res, {
      maxFrames: 1,
      maxBytes: 1000,
      maxFrameBytes: 100,
      slowClientMs: 60_000,
    });
    assert.equal(q.enqueueData('fill'), 'ok');
    assert.equal(q.enqueueData('more'), 'full');
    const abort = new AbortController();
    const c = reg.tryRegister(q, abort, () => {
      q.close();
    });
    assert.ok(c);
    await reg.shutdownAll(50);
    assert.ok(chunks.some((x) => x.includes('event: shutdown')));
  });
});
