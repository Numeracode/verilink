// control-plane/src/domains/policy/policyValidation.ts
import { AppError, CODES } from '../../shared/errors/AppError.js';
import type { PolicyUpdate } from './policyRepository.js';

const ACTIONS_BELOW = ['allow', 'deny'] as const;
const ACTIONS_UNSIGNED = ['passthrough', 'deny'] as const;

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new AppError(CODES.BAD_REQUEST, `${field} must be an array of strings`);
  }
  const out = value.map((v) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new AppError(CODES.BAD_REQUEST, `${field} entries must be non-empty strings`);
    }
    return v;
  });
  if (out.length > 256) {
    throw new AppError(CODES.BAD_REQUEST, `${field} may not exceed 256 entries`);
  }
  return out;
}

/** Validate a PUT /v1/policies/active body into a PolicyUpdate. */
export function parsePolicyUpdate(body: unknown): PolicyUpdate {
  if (!body || typeof body !== 'object') {
    throw new AppError(CODES.BAD_REQUEST, 'Missing policy body');
  }
  const b = body as Record<string, unknown>;

  const threshold = b.threshold ?? 50;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    throw new AppError(CODES.BAD_REQUEST, 'threshold must be an integer between 0 and 100');
  }

  const below = b.below_threshold_action ?? 'deny';
  if (typeof below !== 'string' || !ACTIONS_BELOW.includes(below as (typeof ACTIONS_BELOW)[number])) {
    throw new AppError(CODES.BAD_REQUEST, `below_threshold_action must be one of: ${ACTIONS_BELOW.join(', ')}`);
  }

  const unsigned = b.unsigned_action ?? 'passthrough';
  if (typeof unsigned !== 'string' || !ACTIONS_UNSIGNED.includes(unsigned as (typeof ACTIONS_UNSIGNED)[number])) {
    throw new AppError(CODES.BAD_REQUEST, `unsigned_action must be one of: ${ACTIONS_UNSIGNED.join(', ')}`);
  }

  const failOpen = b.fail_open_expired ?? false;
  if (typeof failOpen !== 'boolean') {
    throw new AppError(CODES.BAD_REQUEST, 'fail_open_expired must be a boolean');
  }
  const noDrop = b.no_drop_decisions ?? false;
  if (typeof noDrop !== 'boolean') {
    throw new AppError(CODES.BAD_REQUEST, 'no_drop_decisions must be a boolean');
  }

  const maxAge = b.max_snapshot_age_seconds ?? 300;
  if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 0) {
    throw new AppError(CODES.BAD_REQUEST, 'max_snapshot_age_seconds must be a non-negative integer');
  }

  const rate = b.allow_sample_rate ?? 0.01;
  if (typeof rate !== 'number' || Number.isNaN(rate) || rate < 0 || rate > 1) {
    throw new AppError(CODES.BAD_REQUEST, 'allow_sample_rate must be a number between 0 and 1');
  }

  return {
    threshold,
    below_threshold_action: below,
    unsigned_action: unsigned,
    allow_fingerprints: asStringArray(b.allow_fingerprints ?? [], 'allow_fingerprints'),
    deny_fingerprints: asStringArray(b.deny_fingerprints ?? [], 'deny_fingerprints'),
    fail_open_expired: failOpen,
    no_drop_decisions: noDrop,
    max_snapshot_age_seconds: maxAge,
    allow_sample_rate: rate,
  };
}
