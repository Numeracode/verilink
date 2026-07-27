'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  VeriLinkClient,
  computeContentDigest,
  buildSignatureBase,
  signRequest,
  verifySignatureInput,
} = require('../index');

function generateEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

function privateKeyToHex(privKeyObj) {
  const jwk = privKeyObj.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  return Buffer.concat([seed, pub]).toString('hex');
}

describe('computeContentDigest', () => {
  it('returns deterministic digest for a given body', () => {
    const body = 'hello world';
    const d1 = computeContentDigest(body);
    const d2 = computeContentDigest(body);
    assert.strictEqual(d1, d2);
    assert.match(d1, /^sha-256=:[A-Za-z0-9_-]+:$/);
  });

  it('returns correct digest for empty buffer', () => {
    const digest = computeContentDigest(Buffer.alloc(0));
    const expected = 'sha-256=:' + crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64url') + ':';
    assert.strictEqual(digest, expected);
  });

  it('returns correct digest for non-empty buffer', () => {
    const buf = Buffer.from('test data');
    const digest = computeContentDigest(buf);
    const expected = 'sha-256=:' + crypto.createHash('sha256').update(buf).digest('base64url') + ':';
    assert.strictEqual(digest, expected);
  });

  it('accepts null body', () => {
    const digest = computeContentDigest(null);
    assert.match(digest, /^sha-256=:[A-Za-z0-9_-]+:$/);
  });
});

describe('buildSignatureBase', () => {
  it('builds correct base string without body (with trailing newline)', () => {
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
    assert.strictEqual(base, expected);
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
    const expected = [
      '"@method": POST',
      '"@target-uri": https://example.com/api',
      '"@created": 1000',
      '"@expires": 2000',
      `"content-digest": ${cd}`,
    ].join('\n') + '\n';
    assert.strictEqual(base, expected);
  });

  it('omits content-digest for empty string body (matches Go)', () => {
    const base = buildSignatureBase({
      method: 'GET',
      targetURI: 'https://example.com',
      created: 1,
      expires: 2,
      body: '',
    });
    assert.ok(!base.includes('content-digest'));
  });

  it('upper-cases the method', () => {
    const base = buildSignatureBase({
      method: 'post',
      targetURI: 'https://example.com',
      created: 1,
      expires: 2,
    });
    assert.ok(base.startsWith('"@method": POST'));
  });

  it('has trailing newline (matches Go)', () => {
    const base = buildSignatureBase({
      method: 'GET',
      targetURI: 'https://example.com',
      created: 1,
      expires: 2,
    });
    assert.ok(base.endsWith('\n'));
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
    assert.ok(result.signatureBase.includes('"@method": POST'));
    assert.ok(result.signatureBase.endsWith('\n'));

    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'POST',
      'https://example.com/api/data',
      () => req.body,
      (kid) => {
        assert.strictEqual(kid, keyid);
        return publicKey;
      }
    );
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.keyid, keyid);
  });

  it('round-trips GET without body', () => {
    const req = {
      url: 'https://example.com/api/items',
      method: 'GET',
      headers: {},
    };

    const result = signRequest(req, privHex, 'mykey', 'did:test-issuer');
    assert.ok(!result.signatureBase.includes('content-digest'));

    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'GET',
      'https://example.com/api/items',
      () => null,
      (kid) => publicKey
    );
    assert.strictEqual(valid.valid, true);
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
      (kid) => publicKey
    );
    assert.strictEqual(valid.valid, false);
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
      () => wrongKey
    );
    assert.strictEqual(valid.valid, false);
  });

  it('returns error when lookupKey throws', () => {
    const req = {
      url: 'https://example.com/api',
      method: 'GET',
      headers: {},
    };

    const result = signRequest(req, privHex, 'mykey', 'did:test-issuer');
    const valid = verifySignatureInput(
      result.sigInput,
      result.signature,
      'GET',
      'https://example.com/api',
      () => null,
      () => { throw new Error('key not found'); }
    );
    assert.strictEqual(valid.valid, false);
    assert.ok(valid.reason.includes('key not found'));
  });

  it('golden vector: sigInput uses ; separators and components first', () => {
    const req = {
      url: 'https://example.com/api',
      method: 'GET',
      headers: {},
      created: 1000,
      expires: 1300,
    };

    const result = signRequest(req, privHex, 'mykey', 'did:test-issuer');
    const expectedPrefix = '"@method" "@target-uri" "@created" "@expires";keyid="vrl:agent:did:test-issuer|mykey";created=1000;expires=1300';
    assert.ok(result.sigInput.startsWith(expectedPrefix), `sigInput=${result.sigInput}`);
    assert.ok(result.sigInput.includes('nonce='));
  });
});

describe('VeriLinkClient.signRequest', () => {
  it('signs using the instance private key (KeyObject)', () => {
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
    assert.ok(req.headers['Signature-Input']);
    assert.ok(req.headers['Signature']);
    assert.ok(req.headers['Signature-Input'].includes('vrl:agent:did:test-issuer|mykey'));

    const valid = verifySignatureInput(
      req.headers['Signature-Input'],
      req.headers['Signature'],
      'POST',
      'https://example.com/api/data',
      () => req.body,
      () => publicKey
    );
    assert.strictEqual(valid.valid, true);
  });
});