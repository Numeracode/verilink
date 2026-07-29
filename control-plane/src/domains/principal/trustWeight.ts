// control-plane/src/domains/principal/trustWeight.ts
import { AppError, CODES } from '../../shared/errors/AppError.js';

/** Inclusive [0,1] — matches trust-engine gRPC validation. */
export function assertTrustWeightInRange(trustWeight?: number): void {
  if (trustWeight === undefined) return;
  if (!Number.isFinite(trustWeight) || trustWeight < 0 || trustWeight > 1) {
    throw new AppError(CODES.BAD_REQUEST, 'trust_weight must be a finite number in [0,1]');
  }
}
