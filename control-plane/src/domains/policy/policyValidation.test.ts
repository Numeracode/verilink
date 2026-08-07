import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyUpdate } from './policyValidation.js';
import { AppError } from '../../shared/errors/AppError.js';

describe('parsePolicyUpdate', () => {
  it('applies defaults for omitted fields', () => {
    const u = parsePolicyUpdate({});
    assert.equal(u.threshold, 50);
    assert.equal(u.below_threshold_action, 'deny');
    assert.equal(u.unsigned_action, 'passthrough');
    assert.equal(u.fail_open_expired, false);
    assert.equal(u.no_drop_decisions, false);
    assert.equal(u.max_snapshot_age_seconds, 300);
    assert.equal(u.allow_sample_rate, 0.01);
    assert.deepEqual(u.allow_fingerprints, []);
    assert.deepEqual(u.deny_fingerprints, []);
  });

  it('accepts a full valid body', () => {
    const u = parsePolicyUpdate({
      threshold: 75,
      below_threshold_action: 'allow',
      unsigned_action: 'deny',
      allow_fingerprints: ['fp-1'],
      deny_fingerprints: ['fp-2'],
      fail_open_expired: true,
      no_drop_decisions: true,
      max_snapshot_age_seconds: 600,
      allow_sample_rate: 0.25,
    });
    assert.equal(u.threshold, 75);
    assert.deepEqual(u.allow_fingerprints, ['fp-1']);
    assert.equal(u.allow_sample_rate, 0.25);
  });

  it('rejects threshold outside 0-100', () => {
    assert.throws(() => parsePolicyUpdate({ threshold: 101 }), /threshold/);
    assert.throws(() => parsePolicyUpdate({ threshold: -1 }), /threshold/);
  });

  it('rejects non-integer threshold', () => {
    assert.throws(() => parsePolicyUpdate({ threshold: 50.5 }), /threshold/);
  });

  it('rejects unknown action values', () => {
    assert.throws(() => parsePolicyUpdate({ below_threshold_action: 'block' }), /below_threshold_action/);
    assert.throws(() => parsePolicyUpdate({ unsigned_action: 'allow' }), /unsigned_action/);
  });

  it('rejects allow_sample_rate outside 0-1', () => {
    assert.throws(() => parsePolicyUpdate({ allow_sample_rate: 1.5 }), /allow_sample_rate/);
    assert.throws(() => parsePolicyUpdate({ allow_sample_rate: -0.1 }), /allow_sample_rate/);
  });

  it('rejects negative max_snapshot_age_seconds', () => {
    assert.throws(() => parsePolicyUpdate({ max_snapshot_age_seconds: -5 }), /max_snapshot_age_seconds/);
  });

  it('rejects non-boolean flags', () => {
    assert.throws(() => parsePolicyUpdate({ fail_open_expired: 'yes' }), /fail_open_expired/);
    assert.throws(() => parsePolicyUpdate({ no_drop_decisions: 1 }), /no_drop_decisions/);
  });

  it('rejects fingerprint arrays with non-string entries', () => {
    assert.throws(() => parsePolicyUpdate({ allow_fingerprints: ['ok', 5] }), /allow_fingerprints/);
  });

  it('rejects non-array fingerprints', () => {
    assert.throws(() => parsePolicyUpdate({ deny_fingerprints: 'fp' }), /deny_fingerprints/);
  });

  it('caps fingerprint array length', () => {
    assert.throws(
      () => parsePolicyUpdate({ allow_fingerprints: Array(257).fill('x') }),
      /256/
    );
  });

  it('rejects a missing/non-object body with 400', () => {
    assert.throws(() => parsePolicyUpdate(null), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 400);
      return true;
    });
  });
});
