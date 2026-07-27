// control-plane/src/domains/attestation/attestationService.ts
import { createHash } from 'node:crypto';
import * as attestationRepo from './attestationRepository.js';
import * as principalRepo from '../principal/principalRepository.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { withTransaction } from '../../db/transaction.js';

// Canonical JSON serialization (RFC 8785 JCS - simplified for v1)
function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function submitAttestation(opts: {
  jwsToken: string;
  verified: {
    issuerId: string;
    subjectId: string;
    keyId: string;
    payload: {
      type: string;
      facts: Record<string, unknown>;
      trustLevelDelta: number;
      schemaVersion?: string;
      visibility?: string;
      observationId?: string;
      issuedAt: Date;
      expiresAt?: Date;
      jti?: string;
    };
  };
}): Promise<attestationRepo.Attestation> {
  const { jwsToken, verified } = opts;

  // Dedup check
  const tokenDigest = sha256hex(jwsToken);
  const existing = await attestationRepo.findByTokenDigest(tokenDigest);
  if (existing) {
    throw new AppError(CODES.CONFLICT, 'Attestation already submitted (duplicate token)');
  }

  // Validate trust_delta range
  if (verified.payload.trustLevelDelta < -100 || verified.payload.trustLevelDelta > 100) {
    throw new AppError(CODES.BAD_REQUEST, 'trust_delta must be between -100 and 100');
  }

  // Validate attestation_type vs trust_delta sign
  const isNegative = verified.payload.type === 'negative_incident';
  if (isNegative && verified.payload.trustLevelDelta >= 0) {
    throw new AppError(CODES.BAD_REQUEST, 'negative_incident must have negative trust_delta');
  }
  if (!isNegative && verified.payload.trustLevelDelta < 0) {
    throw new AppError(CODES.BAD_REQUEST, 'non-negative_incident must have non-negative trust_delta');
  }

  // Verify issuer exists and is an issuer
  const issuer = await principalRepo.getPrincipal(verified.issuerId);
  if (!issuer) {
    throw new AppError(CODES.BAD_REQUEST, 'Issuer principal not found');
  }
  if (issuer.entity_kind === 'agent') {
    throw new AppError(CODES.BAD_REQUEST, 'Principal is not an issuer');
  }

  // Lazy subject creation
  let subject = await principalRepo.getPrincipal(verified.subjectId);
  if (!subject) {
    await principalRepo.createPrincipal(verified.subjectId, 'agent');
  }

  // Compute facts_hash
  const factsHash = sha256hex(canonicalize(verified.payload.facts));

  return withTransaction(async (_client) => {
    const att = await attestationRepo.createAttestation({
      issuerId: verified.issuerId,
      subjectId: verified.subjectId,
      jwsToken,
      tokenDigest,
      payload: verified.payload as unknown as Record<string, unknown>,
      facts: verified.payload.facts,
      factsHash,
      visibility: verified.payload.visibility || 'participants',
      trustDelta: verified.payload.trustLevelDelta,
      attestationType: verified.payload.type,
      schemaVersion: verified.payload.schemaVersion || '0',
      jti: verified.payload.jti,
      observationId: verified.payload.observationId,
      issuedAt: verified.payload.issuedAt,
      expiresAt: verified.payload.expiresAt,
      verifiedKeyId: verified.keyId,
    });

    // TODO: Enqueue RunVeriRank job (debounced, per spec 4.5)
    // For v1, score computation is triggered explicitly via POST /v1/scores/recompute

    return att;
  });
}

export async function getAttestation(id: string): Promise<attestationRepo.Attestation> {
  const att = await attestationRepo.findByTokenDigest(id); // or by UUID
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
