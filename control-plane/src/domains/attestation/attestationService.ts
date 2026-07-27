// control-plane/src/domains/attestation/attestationService.ts
import { createHash } from 'node:crypto';
import * as attestationRepo from './attestationRepository.js';
import * as principalRepo from '../principal/principalRepository.js';
import { preParseJWS } from './jws.js';
import { validateSchema, SchemaValidationError } from './schemaValidator.js';
import { verifyAttestation, type KeyCandidate } from '../../grpc/trustEngineClient.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { withTransaction } from '../../db/transaction.js';

function canonicalize(obj: unknown): string {
  function sortKeys(o: unknown): unknown {
    if (Array.isArray(o)) return o.map(sortKeys);
    if (o && typeof o === 'object' && !(o instanceof Date)) {
      return Object.fromEntries(
        Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)])
      );
    }
    return o;
  }
  return JSON.stringify(sortKeys(obj));
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function submitAttestation(opts: {
  jwsToken: string;
}): Promise<attestationRepo.Attestation> {
  const { jwsToken } = opts;

  // 1. Pre-parse JWS for iss/kid/iat
  let preParsed;
  try {
    preParsed = preParseJWS(jwsToken);
  } catch (err: any) {
    throw new AppError(CODES.BAD_REQUEST, `malformed JWS: ${err.message}`);
  }

  const { header, payload } = preParsed;
  const issuerId = payload.iss;
  const kid = header.kid;
  const iat = payload.iat ? new Date(payload.iat * 1000) : undefined;

  if (!issuerId) {
    throw new AppError(CODES.BAD_REQUEST, 'JWS missing iss claim');
  }
  if (!iat) {
    throw new AppError(CODES.BAD_REQUEST, 'JWS missing iat claim');
  }

  // 2. Look up issuer principal + issuer record
  const issuer = await principalRepo.getPrincipal(issuerId);
  if (!issuer) {
    throw new AppError(CODES.BAD_REQUEST, `unknown issuer: ${issuerId}`);
  }
  const issuerRecord = await principalRepo.getIssuer(issuerId);
  if (!issuerRecord) {
    throw new AppError(CODES.BAD_REQUEST, `principal ${issuerId} is not an issuer`);
  }

  // 3. Resolve candidate keys
  let candidateKeys: principalRepo.PrincipalKey[];
  if (kid) {
    const key = await principalRepo.getKeyByKid(issuerId, kid);
    if (!key) {
      throw new AppError(CODES.BAD_REQUEST, `unknown key id: ${kid} for issuer ${issuerId}`);
    }
    candidateKeys = [key];
  } else {
    candidateKeys = await principalRepo.getActiveKeysAt(issuerId, iat);
  }

  if (candidateKeys.length === 0) {
    throw new AppError(CODES.BAD_REQUEST, `no active keys found for issuer ${issuerId} at iat`);
  }

  // 4. Synchronous signature verification
  const keyCandidates: KeyCandidate[] = candidateKeys.map((k) => ({
    keyId: k.key_id,
    publicKeyRaw: k.public_key_raw,
  }));

  const verifyResult = await verifyAttestation(jwsToken, keyCandidates);
  if (!verifyResult.valid || !verifyResult.payload) {
    throw new AppError(CODES.BAD_REQUEST, `signature verification failed: ${verifyResult.error || 'unknown'}`);
  }

  const vp = verifyResult.payload;
  const verifiedIssuerId = verifyResult.issuerId!;
  const verifiedSubjectId = verifyResult.subjectId!;

  // 5. Schema validation
  try {
    validateSchema(vp.attestationType, vp.schemaVersion, JSON.parse(vp.factsJson));
  } catch (err: any) {
    if (err instanceof SchemaValidationError) {
      throw new AppError(CODES.BAD_REQUEST, `schema validation failed: ${err.message}`);
    }
    throw err;
  }

  // 6. Validate trust_delta range
  if (vp.trustLevelDelta < -100 || vp.trustLevelDelta > 100) {
    throw new AppError(CODES.BAD_REQUEST, 'trust_delta must be between -100 and 100');
  }

  // 7. Validate attestation_type vs trust_delta sign
  const isNegative = vp.attestationType === 'negative_incident';
  if (isNegative && vp.trustLevelDelta >= 0) {
    throw new AppError(CODES.BAD_REQUEST, 'negative_incident must have negative trust_delta');
  }
  if (!isNegative && vp.trustLevelDelta < 0) {
    throw new AppError(CODES.BAD_REQUEST, 'non-negative_incident must have non-negative trust_delta');
  }

  // 8. Dedup on token_digest
  const tokenDigest = sha256hex(jwsToken);
  const existing = await attestationRepo.findByTokenDigest(tokenDigest);
  if (existing) {
    throw new AppError(CODES.CONFLICT, 'attestation already submitted (duplicate token)');
  }

  // 9. Lazy subject creation
  let subject = await principalRepo.getPrincipal(verifiedSubjectId);
  if (!subject) {
    await principalRepo.createPrincipal(verifiedSubjectId, 'agent');
  }

  // 10. Compute facts_hash
  const facts = JSON.parse(vp.factsJson);
  const factsHash = sha256hex(canonicalize(facts));

  // 11. Store attestation transactionally
  try {
    return await withTransaction(async (_client) => {
      return await attestationRepo.createAttestation({
        issuerId: verifiedIssuerId,
        subjectId: verifiedSubjectId,
        jwsToken,
        tokenDigest,
        payload: { type: vp.attestationType, facts, trust_level_delta: vp.trustLevelDelta, schema_version: vp.schemaVersion, visibility: vp.visibility, observation_id: vp.observationId },
        facts,
        factsHash,
        visibility: vp.visibility || 'participants',
        trustDelta: vp.trustLevelDelta,
        attestationType: vp.attestationType,
        schemaVersion: vp.schemaVersion || '0',
        jti: vp.jti || undefined,
        observationId: vp.observationId || undefined,
        issuedAt: new Date(vp.issuedAtUnix * 1000),
        expiresAt: vp.expiresAtUnix > 0 ? new Date(vp.expiresAtUnix * 1000) : undefined,
        verifiedKeyId: verifyResult.verifiedKeyId!,
      });
    });
  } catch (err: any) {
    if (err.code === '23505') {
      throw new AppError(CODES.CONFLICT, 'attestation already submitted (duplicate token)');
    }
    throw err;
  }
}

export async function getAttestation(id: string): Promise<attestationRepo.Attestation> {
  const att = await attestationRepo.findById(id);
  if (!att) throw new AppError(CODES.NOT_FOUND, `Attestation ${id} not found`);
  return att;
}

export async function listAttestations(opts: {
  issuerId?: string;
  subjectId?: string;
  limit?: number;
  offset?: number;
}) {
  return attestationRepo.listAttestations(opts);
}