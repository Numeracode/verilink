import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { assertTrustWeightInRange } from './trustWeight.js';

describe('assertTrustWeightInRange', () => {
  it('accepts 0 and 1', () => {
    assert.doesNotThrow(() => assertTrustWeightInRange(0));
    assert.doesNotThrow(() => assertTrustWeightInRange(1));
    assert.doesNotThrow(() => assertTrustWeightInRange(undefined));
  });

  it('rejects 1.01 and negative', () => {
    assert.throws(
      () => assertTrustWeightInRange(1.01),
      (e: unknown) => e instanceof AppError && e.code === CODES.BAD_REQUEST
    );
    assert.throws(
      () => assertTrustWeightInRange(-0.1),
      (e: unknown) => e instanceof AppError && e.code === CODES.BAD_REQUEST
    );
  });
});
