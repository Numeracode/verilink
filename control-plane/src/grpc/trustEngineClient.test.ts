import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifyAttestation,
  type KeyCandidate,
} from './trustEngineClient.js';

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

function makeKey(): { privateKey: crypto.KeyObject; publicKeyRaw: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const publicKeyRaw = Buffer.from(jwk.x, 'base64url');
  return { privateKey, publicKeyRaw };
}

interface SignOptions {
  privateKey: crypto.KeyObject;
  payload: Record<string, unknown>;
  header?: Record<string, unknown>;
}

function signJws({ privateKey, payload, header }: SignOptions): string {
  const headerB64 = base64url(JSON.stringify(header ?? { alg: 'EdDSA', typ: 'JWT' }));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signedInput = Buffer.from(headerB64 + '.' + payloadB64, 'utf8');
  const signature = crypto.sign(null, signedInput, privateKey);
  return `${headerB64}.${payloadB64}.${base64url(signature)}`;
}

const samplePayload = {
  iss: 'vrl:p:00000000-0000-4000-8000-000000000001',
  sub: 'vrl:p:00000000-0000-4000-8000-000000000002',
  iat: 1700000000,
  exp: 1900000000,
  jti: 'att-001',
  attestation_type: 'observed_run',
  facts: { ran: true, duration_s: 42 },
  trust_level_delta: 5,
  schema_version: '1',
  visibility: 'participants',
  observation_id: 'obs-7',
};

describe('verifyAttestation', () => {
  test('valid token verifies with matching key', async () => {
    const { privateKey, publicKeyRaw } = makeKey();
    const token = signJws({ privateKey, payload: samplePayload });
    const candidates: KeyCandidate[] = [{ keyId: 'k1', publicKeyRaw }];

    const result = await verifyAttestation(token, candidates);

    assert.equal(result.valid, true);
    assert.equal(result.verifiedKeyId, 'k1');
    assert.equal(result.issuerId, samplePayload.iss);
    assert.equal(result.subjectId, samplePayload.sub);
    assert.equal(result.payload?.attestationType, 'observed_run');
    assert.equal(result.payload?.trustLevelDelta, 5);
    assert.equal(result.payload?.issuedAtUnix, 1700000000);
    assert.equal(result.payload?.expiresAtUnix, 1900000000);
    assert.equal(result.payload?.jti, 'att-001');
    assert.equal(result.payload?.visibility, 'participants');
    assert.equal(result.payload?.observationId, 'obs-7');
    assert.deepEqual(JSON.parse(result.payload!.factsJson), { ran: true, duration_s: 42 });
  });

  test('wrong key fails verification', async () => {
    const signer = makeKey();
    const wrong = makeKey();
    const token = signJws({ privateKey: signer.privateKey, payload: samplePayload });
    const candidates: KeyCandidate[] = [{ keyId: 'k1', publicKeyRaw: wrong.publicKeyRaw }];

    const result = await verifyAttestation(token, candidates);

    assert.equal(result.valid, false);
    assert.equal(result.verifiedKeyId, undefined);
    assert.match(result.error ?? '', /no candidate key verified/);
  });

  test('multiple candidates — one correct verifies', async () => {
    const correct = makeKey();
    const other = makeKey();
    const token = signJws({ privateKey: correct.privateKey, payload: samplePayload });
    const candidates: KeyCandidate[] = [
      { keyId: 'wrong-1', publicKeyRaw: other.publicKeyRaw },
      { keyId: 'correct', publicKeyRaw: correct.publicKeyRaw },
      { keyId: 'wrong-2', publicKeyRaw: makeKey().publicKeyRaw },
    ];

    const result = await verifyAttestation(token, candidates);

    assert.equal(result.valid, true);
    assert.equal(result.verifiedKeyId, 'correct');
  });

  test('no candidates returns invalid', async () => {
    const { privateKey } = makeKey();
    const token = signJws({ privateKey, payload: samplePayload });

    const result = await verifyAttestation(token, []);

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /no candidate keys provided/);
  });

  test('tampered token fails verification', async () => {
    const { privateKey, publicKeyRaw } = makeKey();
    const token = signJws({ privateKey, payload: samplePayload });
    const parts = token.split('.');
    // Flip a bit in the payload section.
    const decoded = base64urlDecode(parts[1]);
    decoded[0] = decoded[0] ^ 0xff;
    const tamperedPayload = base64url(decoded);
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const candidates: KeyCandidate[] = [{ keyId: 'k1', publicKeyRaw }];

    const result = await verifyAttestation(tampered, candidates);

    assert.equal(result.valid, false);
  });

  test('malformed token returns invalid', async () => {
    const { publicKeyRaw } = makeKey();
    const candidates: KeyCandidate[] = [{ keyId: 'k1', publicKeyRaw }];

    const result = await verifyAttestation('not.a.jws', candidates);

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /malformed|invalid|no candidate key/);
  });

  test('empty token returns invalid', async () => {
    const { publicKeyRaw } = makeKey();
    const result = await verifyAttestation('', [{ keyId: 'k1', publicKeyRaw }]);

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /jws_token is required/);
  });

  test('unsupported alg fails', async () => {
    const { privateKey, publicKeyRaw } = makeKey();
    const token = signJws({
      privateKey,
      payload: samplePayload,
      header: { alg: 'RS256', typ: 'JWT' },
    });
    const candidates: KeyCandidate[] = [{ keyId: 'k1', publicKeyRaw }];

    const result = await verifyAttestation(token, candidates);

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /unsupported alg/);
  });
});

function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input + pad, 'base64');
}