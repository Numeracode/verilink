import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WINDOW_MS, MAX_WINDOW_MS, resolveTimeWindow } from './timeWindow.js';
import { AppError } from '../shared/errors/AppError.js';

describe('resolveTimeWindow', () => {
  it('defaults to the last 24h', () => {
    const before = Date.now();
    const { from, to } = resolveTimeWindow(undefined, undefined);
    const after = Date.now();
    assert.ok(to.getTime() >= before && to.getTime() <= after);
    assert.equal(to.getTime() - from.getTime(), DEFAULT_WINDOW_MS);
  });

  it('accepts an explicit window', () => {
    const { from, to } = resolveTimeWindow('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
    assert.equal(from.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(to.toISOString(), '2026-08-02T00:00:00.000Z');
  });

  it('anchors the default window at an explicit to', () => {
    const { from, to } = resolveTimeWindow(undefined, '2026-08-02T00:00:00Z');
    assert.equal(to.toISOString(), '2026-08-02T00:00:00.000Z');
    assert.equal(from.toISOString(), '2026-08-01T00:00:00.000Z');
  });

  it('rejects unparseable timestamps', () => {
    assert.throws(() => resolveTimeWindow('not-a-date', undefined), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 400);
      return true;
    });
  });

  it('rejects Date-parseable but non-ISO 8601 forms (ambiguous)', () => {
    for (const bad of ['January 2, 2024', '01/02/2024', '2024/01/02']) {
      assert.throws(
        () => resolveTimeWindow(bad, undefined),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 400);
          return true;
        },
        `expected ${bad} to be rejected`
      );
    }
  });

  it('accepts date-only and zoned ISO 8601 timestamps', () => {
    const a = resolveTimeWindow('2026-08-01', '2026-08-02');
    assert.equal(a.from.toISOString(), '2026-08-01T00:00:00.000Z');
    const b = resolveTimeWindow('2026-08-01T00:00:00+00:00', '2026-08-02T00:00:00Z');
    assert.equal(b.to.toISOString(), '2026-08-02T00:00:00.000Z');
  });

  it('rejects from > to', () => {
    assert.throws(
      () => resolveTimeWindow('2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z'),
      /before or equal/
    );
  });

  it('rejects ranges beyond the 31d maximum', () => {
    const from = new Date(0);
    const to = new Date(MAX_WINDOW_MS + 1000);
    assert.throws(
      () => resolveTimeWindow(from.toISOString(), to.toISOString()),
      /31 day maximum/
    );
  });
});
