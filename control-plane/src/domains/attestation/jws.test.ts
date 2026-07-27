// control-plane/src/domains/attestation/jws.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { preParseJWS } from './jws.js';

function makeJWS(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedHeader}.${encodedPayload}.dummy-signature`;
}

describe('preParseJWS', () => {
  it('parses a valid token', () => {
    const token = makeJWS(
      { alg: 'ES256', kid: 'key-1', typ: 'JWT' },
      { iss: 'issuer-1', sub: 'subject-1', iat: 1700000000 }
    );
    const result = preParseJWS(token);
    assert.equal(result.header.alg, 'ES256');
    assert.equal(result.header.kid, 'key-1');
    assert.equal(result.header.typ, 'JWT');
    assert.equal(result.payload.iss, 'issuer-1');
    assert.equal(result.payload.sub, 'subject-1');
    assert.equal(result.payload.iat, 1700000000);
  });

  it('extracts iss/kid/iat', () => {
    const token = makeJWS(
      { alg: 'ES256', kid: 'key-abc' },
      { iss: 'did:web:issuer', iat: 1700000000 }
    );
    const { header, payload } = preParseJWS(token);
    assert.equal(header.kid, 'key-abc');
    assert.equal(payload.iss, 'did:web:issuer');
    assert.equal(payload.iat, 1700000000);
  });

  it('rejects malformed token (not 3 parts)', () => {
    assert.throws(() => preParseJWS('not.a.valid.jws.token'), /3 compact serialization parts/);
    assert.throws(() => preParseJWS('onlyone'), /3 compact serialization parts/);
    assert.throws(() => preParseJWS('a.b'), /3 compact serialization parts/);
  });

  it('rejects invalid base64', () => {
    const bad = `not_base64url!.{"iss":"ok"}.sig`;
    assert.throws(() => preParseJWS(bad), /base64url/);
  });

  it('rejects invalid JSON', () => {
    const encoded = Buffer.from('{not json', 'utf8').toString('base64url');
    const encodedPayload = Buffer.from('{"iss":"ok"}', 'utf8').toString('base64url');
    const token = `${encoded}.${encodedPayload}.sig`;
    assert.throws(() => preParseJWS(token), /invalid JSON/);
  });

  it('rejects missing alg', () => {
    const token = makeJWS({ kid: 'key-1' }, { iss: 'issuer-1' });
    assert.throws(() => preParseJWS(token), /header\.alg is required/);
  });
});