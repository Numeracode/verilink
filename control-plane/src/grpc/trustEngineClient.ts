// In v1, attestation verification is done in-process using Node's crypto module
// rather than calling the Go gRPC server. This avoids proto generation complexity
// and keeps the control plane self-contained. The VerifyAttestation gRPC contract
// (proto/verilink/trust/v1/trust.proto) is mirrored here as a plain TypeScript API.

import crypto from 'node:crypto';

export interface KeyCandidate {
  keyId: string;
  publicKeyRaw: Buffer; // raw 32-byte Ed25519 public key
}

export interface VerifyPayload {
  attestationType: string;
  factsJson: string;
  trustLevelDelta: number;
  issuedAtUnix: number;
  expiresAtUnix: number;
  jti: string;
  schemaVersion: string;
  visibility: string;
  observationId: string;
}

export interface VerifyResult {
  valid: boolean;
  verifiedKeyId?: string;
  issuerId?: string;
  subjectId?: string;
  payload?: VerifyPayload;
  error?: string;
}

interface DecodedJws {
  headerB64: string;
  payloadB64: string;
  signature: Buffer;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signedInput: Buffer; // header.payload
}

function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input + pad, 'base64');
}

function parseJws(token: string): DecodedJws {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid JWS: expected 3 compact parts');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  const signature = base64urlDecode(signatureB64);
  const signedInput = Buffer.from(headerB64 + '.' + payloadB64, 'utf8');
  return { headerB64, payloadB64, signature, header, payload, signedInput };
}

function ed25519PublicKey(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) {
    throw new Error(`invalid Ed25519 public key length: ${raw.length}`);
  }
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function toPayload(jwsPayload: Record<string, unknown>): VerifyPayload {
  // VeriLink attestations nest behavioral claims under "vli" (per
  // pkg/attestation.AttestationClaims). Fall back to top-level for
  // non-conformant legacy tokens.
  const hasVli = jwsPayload.vli && typeof jwsPayload.vli === 'object';
  const vli = hasVli
    ? jwsPayload.vli as Record<string, unknown>
    : jwsPayload;

  // schema_version: native v1 must be explicit. Legacy tokens (no vli or
  // vli without schema_version) default to "0" for allowlisted compatibility.
  const explicitVersion = vli.schema_version ?? vli.schemaVersion;
  const schemaVersion = explicitVersion != null
    ? String(explicitVersion)
    : (hasVli ? '1' : '0');

  return {
    attestationType: String(vli.type ?? vli.attestation_type ?? ''),
    factsJson: typeof vli.facts === 'string'
      ? vli.facts
      : JSON.stringify(vli.facts ?? {}),
    trustLevelDelta: Number(vli.trust_level_delta ?? vli.trustLevelDelta ?? 0),
    issuedAtUnix: Number(jwsPayload.iat ?? 0),
    expiresAtUnix: Number(jwsPayload.exp ?? 0),
    jti: String(jwsPayload.jti ?? ''),
    schemaVersion,
    visibility: String(vli.visibility ?? 'participants'),
    observationId: String(vli.observation_id ?? vli.observationId ?? ''),
  };
}

export async function verifyAttestation(
  jwsToken: string,
  candidateKeys: KeyCandidate[],
): Promise<VerifyResult> {
  if (typeof jwsToken !== 'string' || jwsToken.length === 0) {
    return { valid: false, error: 'jws_token is required' };
  }
  if (!Array.isArray(candidateKeys) || candidateKeys.length === 0) {
    return { valid: false, error: 'no candidate keys provided' };
  }

  let jws: DecodedJws;
  try {
    jws = parseJws(jwsToken);
  } catch (err) {
    return { valid: false, error: `malformed JWS: ${(err as Error).message}` };
  }

  const alg = String(jws.header.alg ?? '');
  if (alg !== 'EdDSA' && alg !== 'Ed25519') {
    return { valid: false, error: `unsupported alg: ${alg}` };
  }

  const payload = jws.payload;
  const issuerId = String(payload.iss ?? '');
  const subjectId = String(payload.sub ?? '');

  for (const candidate of candidateKeys) {
    if (!candidate.publicKeyRaw || candidate.publicKeyRaw.length !== 32) {
      continue;
    }
    let keyObj: crypto.KeyObject;
    try {
      keyObj = ed25519PublicKey(candidate.publicKeyRaw);
    } catch {
      continue;
    }

    let ok = false;
    try {
      ok = crypto.verify(
        null,
        jws.signedInput,
        keyObj,
        jws.signature,
      );
    } catch {
      ok = false;
    }
    if (!ok) continue;

    const result: VerifyResult = {
      valid: true,
      verifiedKeyId: candidate.keyId,
      issuerId,
      subjectId,
      payload: toPayload(payload),
    };

    // Expiration check: reject expired tokens
    if (result.payload!.expiresAtUnix > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now >= result.payload!.expiresAtUnix) {
        return { valid: false, error: `token expired at ${result.payload!.expiresAtUnix}` };
      }
    }

    return result;
  }

  return { valid: false, error: 'no candidate key verified the token' };
}