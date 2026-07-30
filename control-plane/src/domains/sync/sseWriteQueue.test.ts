import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import {
  SseWriteQueue,
  formatSseComment,
  formatSseEvent,
} from './sseWriteQueue.js';

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

describe('SseWriteQueue', () => {
  it('formats cursor and ping frames', () => {
    assert.match(formatSseEvent({ event: 'cursor', id: 0n, data: '{}' }), /event: cursor/);
    assert.equal(formatSseComment('ping'), ': ping\n\n');
  });

  it('rejects oversized data frames', () => {
    const res = mockRes();
    const q = new SseWriteQueue(res, {
      maxFrames: 10,
      maxBytes: 10_000,
      maxFrameBytes: 8,
      slowClientMs: 60_000,
    });
    assert.equal(q.enqueueData('0123456789'), 'oversized');
  });

  it('returns full when frame cap exceeded', () => {
    const res = mockRes();
    const q = new SseWriteQueue(res, {
      maxFrames: 1,
      maxBytes: 10_000,
      maxFrameBytes: 1000,
      slowClientMs: 60_000,
    });
    assert.equal(q.enqueueData('a', 1n), 'ok');
    assert.equal(q.enqueueData('b', 2n), 'full');
    q.close();
  });

  it('control frame accepted when data queue is full', () => {
    const res = mockRes();
    const q = new SseWriteQueue(res, {
      maxFrames: 1,
      maxBytes: 10_000,
      maxFrameBytes: 1000,
      slowClientMs: 60_000,
    });
    assert.equal(q.enqueueData('a', 1n), 'ok');
    assert.equal(q.enqueueData('b', 2n), 'full');
    assert.equal(q.enqueueControl(formatSseEvent({ event: 'shutdown', data: '{}' })), 'ok');
    q.close();
  });

  it('rejects frames that exceed maxBytes even if under maxFrameBytes', () => {
    const res = mockRes();
    const q = new SseWriteQueue(res, {
      maxFrames: 10,
      maxBytes: 20,
      maxFrameBytes: 100,
      slowClientMs: 60_000,
    });
    assert.equal(q.enqueueData('x'.repeat(30)), 'oversized');
    q.close();
  });

  it('tracks lastWrittenCursor after successful write', async () => {
    const res = mockRes();
    const q = new SseWriteQueue(res, {
      maxFrames: 10,
      maxBytes: 10_000,
      maxFrameBytes: 1000,
      slowClientMs: 60_000,
    });
    assert.equal(q.enqueueData('x', 5n), 'ok');
    assert.equal(q.enqueueData('y', 9n), 'ok');
    await new Promise((r) => setImmediate(r));
    assert.equal(q.writtenCursor, 9n);
    q.close();
  });
});
