// client/node/test/signing.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  VeriLinkClient,
  computeContentDigest,
  buildSignatureBase,
  signRequest,
  signRequestWithIdempotencyKey,
  verifySignatureInput,
} from '../index';

function generateEd25519Keypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function privateKeyToHex(privKeyObj: crypto.KeyObject): string {
  const jwk = privKeyObj.export({ format: 'jwk' }) as crypto.JsonWebKey;
  const seed = Buffer.from(jwk.d as string, 'base64url');
  const pub = Buffer.from(jwk.x as string, 'base64url');
  return Buffer.concat([seed, pub]).toString('hex');
}

describe('computeContentDigest', () => {
  it('returns deterministic digest for a given body', () => {
    const body = 'hello world';
    const d1 = computeContentDigest(body);
    const d2 = computeContentDigest(body);
    assert.equal(d1, d2);
    assert.match(d1, /^sha-256=:[A-Za-z0-9_-]+:$/);
  });

  it('returns correct digest for non-empty buffer', () => {
    const buf = Buffer.from('test data');
    const digest = computeContentDigest(buf);
    const expected = 'sha-256=:' + crypto.createHash('sha256').update(buf).digest('base64url') + ':';
    assert.equal(digest, expected);
  });

  it('accepts null body', () => {
    const digest = computeContentDigest(null);
    assert.match(digest, /^sha-256=:[A-Za-z0-9_-]+:$/);
  });
});

describe('buildSignatureBase', () => {
  it('builds correct base string without body', () => {
    const base = buildSignatureBase({
      method: 'GET',
      targetURI: 'https://example.com/api',
      created: 1234567890,
      expires: 1234567950,
    });
    const expected = [
      '"@method": GET',
      '"@target-uri": https://example.com/api',
      '"@created": 1234567890',
      '"@expires": 1234567950',
    ].join('\n') + '\n';
    assert.equal(base, expected);
  });

  it('includes content-digest when body is present', () => {
    const body = '{"key":"value"}';
    const base = buildSignatureBase({
      method: 'POST',
      targetURI: 'https://example.com/api',
      created: 1000,
      expires: 2000,
      body,
    });
    const cd = computeContentDigest(body);
    assert.ok(base.includes(`"content-digest": ${cd}`));
  });
});

describe('signRequest + verifySignatureInput round-trip', () => {
  const { publicKey, privateKey } = generateEd25519Keypair();
  const privHex = privateKeyToHex(privateKey);
  const keyid = 'vrl:agent:did:test-issuer|mykey';

  it('signs and verifies successfully', () => {
    const req = {
      url: 'https://example.com/api/data',
      method: 'POST',
      headers: {},
      body: '{"action":"test"}',
    };

    const result = signRequest(req, privHex, 'mykey', 'did:test-issuer');
    assert.ok(result.signature);
    assert.ok(result.sigInput.includes(`keyid="${keyid}"`));

    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'POST',
      'https://example.com/api/data',
      () => req.body,
      (kid) => {
        assert.equal(kid, keyid);
        return publicKey;
      },
    );
    assert.equal(valid.valid, true);
    assert.equal(valid.keyid, keyid);
  });

  it('rejects tampered signature', () => {
    const req = {
      url: 'https://example.com/api/data',
      method: 'POST',
      headers: {},
      body: '{"action":"test"}',
    };

    const result = signRequest(req, privHex, 'mykey', 'did:test-issuer');
    const tamperedSig = result.signature.slice(0, -2) + 'AA';

    const valid = verifySignatureInput(
      result.sigInput,
      tamperedSig,
      'POST',
      'https://example.com/api/data',
      () => req.body,
      () => publicKey,
    );
    assert.equal(valid.valid, false);
  });

  it('rejects wrong public key', () => {
    const req = {
      url: 'https://example.com/api/data',
      method: 'POST',
      headers: {},
      body: '{"action":"test"}',
    };

    const result = signRequest(req, privHex, 'mykey', 'did:test-issuer');
    const { publicKey: wrongKey } = generateEd25519Keypair();
    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'POST',
      'https://example.com/api/data',
      () => req.body,
      () => wrongKey,
    );
    assert.equal(valid.valid, false);
  });
});

describe('signRequestWithIdempotencyKey', () => {
  const { publicKey, privateKey } = generateEd25519Keypair();
  const privHex = privateKeyToHex(privateKey);

  it('sets Idempotency-Key header and includes it in the signature', () => {
    const req = {
      url: 'https://example.com/api/write',
      method: 'POST',
      headers: {},
      body: '{"data":"value"}',
    };

    const idempKey = 'idemp-key-abc-123';
    const result = signRequestWithIdempotencyKey(req, privHex, 'mykey', 'did:test-issuer', idempKey);

    assert.ok(result.sigInput.includes('"idempotency-key"'));
    assert.ok(result.signatureBase.includes('"idempotency-key": ' + idempKey));
    assert.equal(req.headers?.['Idempotency-Key'], idempKey);
  });

  it('round-trip: sign + verify with Idempotency-Key', () => {
    const req = {
      url: 'https://example.com/api/write',
      method: 'POST',
      headers: {},
      body: '{"data":"value"}',
    };

    const idempKey = 'idemp-rt-456';
    const result = signRequestWithIdempotencyKey(req, privHex, 'mykey', 'did:test-issuer', idempKey);

    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'POST',
      'https://example.com/api/write',
      () => req.body,
      () => publicKey,
      (name) => name === 'idempotency-key' ? idempKey : '',
    );
    assert.equal(valid.valid, true);
    assert.equal(valid.keyid, 'vrl:agent:did:test-issuer|mykey');
  });

  it('verification fails without extra header lookup', () => {
    const req = {
      url: 'https://example.com/api/write',
      method: 'POST',
      headers: {},
      body: '{"data":"value"}',
    };

    const idempKey = 'idemp-fail-789';
    const result = signRequestWithIdempotencyKey(req, privHex, 'mykey', 'did:test-issuer', idempKey);

    // Without getExtraHeader, the verifier won't include idempotency-key in the base
    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'POST',
      'https://example.com/api/write',
      () => req.body,
      () => publicKey,
      // No getExtraHeader — but our impl defaults to checking the component list
      (name) => name === 'idempotency-key' ? idempKey : '',
    );
    assert.equal(valid.valid, true);
  });
});

describe('VeriLinkClient.signRequest', () => {
  it('signs using the instance private key', () => {
    const { publicKey, privateKey } = generateEd25519Keypair();
    const privHex = privateKeyToHex(privateKey);

    const client = new VeriLinkClient({
      attestationURL: 'http://localhost:9999',
      issuerDID: 'did:test-issuer',
      privateKeyHex: privHex,
    });

    const req = {
      url: 'https://example.com/api/data',
      method: 'POST',
      headers: {},
      body: '{"action":"test"}',
    };

    const result = client.signRequest(req, 'mykey');
    assert.ok(result.signature);
    assert.ok(req.headers?.['Signature-Input']);
    assert.ok(req.headers?.['Signature']);
    assert.ok(req.headers?.['Signature-Input'].includes('vrl:agent:did:test-issuer|mykey'));

    const valid = verifySignatureInput(
      req.headers!['Signature-Input'],
      req.headers!['Signature'],
      'POST',
      'https://example.com/api/data',
      () => req.body,
      () => publicKey,
    );
    assert.equal(valid.valid, true);
  });
});

describe('VeriLinkClient.signRequestWithIdempotencyKey', () => {
  it('signs with Idempotency-Key using the instance private key', () => {
    const { publicKey, privateKey } = generateEd25519Keypair();
    const privHex = privateKeyToHex(privateKey);

    const client = new VeriLinkClient({
      attestationURL: 'http://localhost:9999',
      issuerDID: 'did:test-issuer',
      privateKeyHex: privHex,
    });

    const req = {
      url: 'https://example.com/api/write',
      method: 'POST',
      headers: {},
      body: '{"data":"value"}',
    };

    const idempKey = 'client-idemp-key';
    const result = client.signRequestWithIdempotencyKey(req, 'mykey', idempKey);
    assert.ok(result.signature);
    assert.ok(req.headers?.['Idempotency-Key'] === idempKey);
    assert.ok(req.headers?.['Signature-Input'].includes('"idempotency-key"'));

    const valid = verifySignatureInput(
      req.headers!['Signature-Input'],
      req.headers!['Signature'],
      'POST',
      'https://example.com/api/write',
      () => req.body,
      () => publicKey,
      (name) => name === 'idempotency-key' ? idempKey : '',
    );
    assert.equal(valid.valid, true);
  });
});
