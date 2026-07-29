import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForDrainOrFailure } from './runVeriRankClient.js';

describe('waitForDrainOrFailure', () => {
  it('does not accumulate listeners after successful drains', async () => {
    const call = new EventEmitter();
    for (let i = 0; i < 20; i++) {
      const pending = waitForDrainOrFailure(call);
      call.emit('drain');
      await pending;
    }
    assert.equal(call.listenerCount('drain'), 0);
    assert.equal(call.listenerCount('error'), 0);
    assert.equal(call.listenerCount('close'), 0);
  });

  it('rejects on error and clears listeners', async () => {
    const call = new EventEmitter();
    const pending = waitForDrainOrFailure(call);
    call.emit('error', new Error('boom'));
    await assert.rejects(pending, /boom/);
    assert.equal(call.listenerCount('drain'), 0);
    assert.equal(call.listenerCount('error'), 0);
    assert.equal(call.listenerCount('close'), 0);
  });

  it('rejects on close and clears listeners', async () => {
    const call = new EventEmitter();
    const pending = waitForDrainOrFailure(call);
    call.emit('close');
    await assert.rejects(pending, /closed before drain/);
    assert.equal(call.listenerCount('drain'), 0);
    assert.equal(call.listenerCount('error'), 0);
    assert.equal(call.listenerCount('close'), 0);
  });
});
