import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RecomputeScheduler } from './recomputeScheduler.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('RecomputeScheduler', () => {
  let calls: Date[];
  let gate: { release: () => void; wait: Promise<void> } | null;
  let scheduler: RecomputeScheduler;

  beforeEach(() => {
    calls = [];
    gate = null;
    scheduler = new RecomputeScheduler({
      debounceMs: 30,
      intervalMs: 60_000,
      recompute: async (t) => {
        calls.push(t);
        if (gate) await gate.wait;
      },
    });
    scheduler.start();
  });

  afterEach(async () => {
    if (gate) gate.release();
    await scheduler.stop();
  });

  it('coalesces concurrent markDirty while running into one follow-up run', async () => {
    let resolveGate!: () => void;
    gate = {
      wait: new Promise<void>((r) => {
        resolveGate = r;
      }),
      release: () => resolveGate(),
    };

    const first = scheduler.kick();
    await delay(5);
    assert.equal(scheduler.isRunning, true);
    scheduler.markDirty();
    scheduler.markDirty();
    scheduler.markDirty();
    resolveGate();
    await first;
    // Allow follow-up loop to finish
    await delay(20);
    assert.equal(calls.length, 2);
  });

  it('stop finishes active run, drains one dirty, ignores further dirty', async () => {
    await scheduler.stop();
    const runOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstWait = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let drainStarted!: () => void;
    const drainSeen = new Promise<void>((r) => {
      drainStarted = r;
    });
    let n = 0;

    scheduler = new RecomputeScheduler({
      debounceMs: 30,
      intervalMs: 60_000,
      recompute: async () => {
        n += 1;
        runOrder.push(`run-${n}`);
        if (n === 1) {
          await firstWait;
        } else if (n === 2) {
          drainStarted();
          // During drain, further triggers set dirty but must not cause a third run.
          void scheduler.kick();
          await delay(5);
        }
      },
    });
    scheduler.start();

    const kickP = scheduler.kick();
    await delay(5);
    scheduler.markDirty();
    const stopP = scheduler.stop();
    resolveFirst();
    await Promise.all([kickP, stopP, drainSeen]);
    await delay(20);

    assert.deepEqual(runOrder, ['run-1', 'run-2']);
    assert.equal(scheduler.isDirty, false);
    assert.equal(scheduler.isRunning, false);
  });

  it('markDirty is no-op while stopping', async () => {
    await scheduler.stop();
    scheduler.markDirty();
    await delay(50);
    assert.equal(calls.length, 0);
  });

  it('markDirty is no-op before start', async () => {
    await scheduler.stop();
    const idle = new RecomputeScheduler({
      debounceMs: 10,
      intervalMs: 60_000,
      recompute: async (t) => {
        calls.push(t);
      },
    });
    idle.markDirty();
    await delay(40);
    assert.equal(calls.length, 0);
    await idle.stop();
  });
});
