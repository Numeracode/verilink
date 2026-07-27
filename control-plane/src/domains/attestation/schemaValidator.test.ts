import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { validateSchema, SchemaValidationError } from './schemaValidator.js';

describe('validateSchema — behavioral', () => {
  it('behavioral@0 accepts any object (no allowlist set)', () => {
    assert.doesNotThrow(() => validateSchema('behavioral', '0', { action: 'test' }));
  });

  it('behavioral@0 accepts empty object', () => {
    assert.doesNotThrow(() => validateSchema('behavioral', '0', {}));
  });

  it('behavioral@1 accepts valid facts', () => {
    assert.doesNotThrow(() =>
      validateSchema('behavioral', '1', { action: 'commit', count: 5 }),
    );
  });

  it('behavioral@1 rejects empty facts', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', {}),
      SchemaValidationError,
    );
  });

  it('behavioral@1 rejects nested objects', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', { nested: { a: 1 } }),
      SchemaValidationError,
    );
  });

  it('behavioral@1 rejects arrays', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', { items: [1, 2] }),
      SchemaValidationError,
    );
  });
});

describe('validateSchema — behavioral@0 allowlist', () => {
  const origAllowlist = process.env.BEHAVIORAL_V0_ALLOWLIST;
  const origCutoff = process.env.BEHAVIORAL_V0_CUTOFF;

  afterEach(() => {
    delete process.env.BEHAVIORAL_V0_ALLOWLIST;
    delete process.env.BEHAVIORAL_V0_CUTOFF;
    if (origAllowlist) process.env.BEHAVIORAL_V0_ALLOWLIST = origAllowlist;
    if (origCutoff) process.env.BEHAVIORAL_V0_CUTOFF = origCutoff;
  });

  it('rejects behavioral@0 from non-allowlisted issuer', () => {
    process.env.BEHAVIORAL_V0_ALLOWLIST = 'vrl:p:whimsy-issuer';
    assert.throws(
      () => validateSchema('behavioral', '0', { action: 'test' }, 'vrl:p:other-issuer'),
      SchemaValidationError,
    );
  });

  it('accepts behavioral@0 from allowlisted issuer', () => {
    process.env.BEHAVIORAL_V0_ALLOWLIST = 'vrl:p:whimsy-issuer';
    assert.doesNotThrow(() =>
      validateSchema('behavioral', '0', { action: 'test' }, 'vrl:p:whimsy-issuer'),
    );
  });

  it('rejects behavioral@0 after cutoff', () => {
    process.env.BEHAVIORAL_V0_CUTOFF = '2020-01-01T00:00:00Z';
    assert.throws(
      () => validateSchema('behavioral', '0', { action: 'test' }),
      SchemaValidationError,
    );
  });

  it('rejects behavioral@0 for non-behavioral types', () => {
    assert.throws(
      () => validateSchema('negative_incident', '0', { category: 'x' }),
      SchemaValidationError,
    );
  });
});

describe('validateSchema — native attestation types', () => {
  it('transaction_summary@1 accepts valid facts', () => {
    assert.doesNotThrow(() =>
      validateSchema('transaction_summary', '1', {
        start: '2024-01-01',
        end: '2024-01-31',
        success_count: 100,
        failure_count: 5,
        dispute_count: 1,
      }),
    );
  });

  it('transaction_summary@1 rejects missing required field', () => {
    assert.throws(
      () =>
        validateSchema('transaction_summary', '1', {
          start: '2024-01-01',
          end: '2024-01-31',
          success_count: 100,
          failure_count: 5,
        }),
      SchemaValidationError,
    );
  });

  it('kyb@1 accepts valid facts', () => {
    assert.doesNotThrow(() =>
      validateSchema('kyb', '1', {
        status: 'verified',
        verifier: 'ACME Corp',
        jurisdiction: 'US',
        verification_timestamp: '2024-01-01',
        expiry_timestamp: '2025-01-01',
      }),
    );
  });

  it('kyb@1 rejects missing required field', () => {
    assert.throws(
      () => validateSchema('kyb', '1', { status: 'verified' }),
      SchemaValidationError,
    );
  });

  it('security_audit@1 accepts valid facts', () => {
    assert.doesNotThrow(() =>
      validateSchema('security_audit', '1', {
        standard: 'SOC2',
        result: 'pass',
        auditor: 'Big4',
        report_digest: 'abc123',
        audit_timestamp: '2024-01-01',
      }),
    );
  });

  it('security_audit@1 rejects missing required field', () => {
    assert.throws(
      () => validateSchema('security_audit', '1', { standard: 'SOC2' }),
      SchemaValidationError,
    );
  });

  it('negative_incident@1 accepts valid facts', () => {
    assert.doesNotThrow(() =>
      validateSchema('negative_incident', '1', {
        category: 'abuse',
        severity: 'high',
        occurrence_timestamp: '2024-01-01',
        evidence_digest: 'sha256:abc',
      }),
    );
  });

  it('negative_incident@1 rejects missing required field', () => {
    assert.throws(
      () => validateSchema('negative_incident', '1', { category: 'abuse' }),
      SchemaValidationError,
    );
  });
});

describe('validateSchema — edge cases', () => {
  it('unknown type rejects', () => {
    assert.throws(
      () => validateSchema('unknown', '1', { a: 1 }),
      SchemaValidationError,
    );
  });

  it('unknown schema version rejects', () => {
    assert.throws(
      () => validateSchema('behavioral', '2', { a: 1 }),
      SchemaValidationError,
    );
  });

  it('null facts rejects', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', null as any),
      SchemaValidationError,
    );
  });
});