// control-plane/src/domains/principal/principalService.ts
import { randomUUID } from 'node:crypto';
import * as principalRepo from './principalRepository.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { withTransaction } from '../../db/transaction.js';
import { assertTrustWeightInRange } from './trustWeight.js';

export async function createPrincipal(opts: {
  entityKind: string;
  ownerTenantId?: string;
  name?: string;
}): Promise<principalRepo.Principal> {
  const id = `vrl:p:${randomUUID()}`;
  return principalRepo.createPrincipal(id, opts.entityKind, opts.ownerTenantId, opts.name);
}

export async function getPrincipal(id: string): Promise<principalRepo.Principal> {
  const p = await principalRepo.getPrincipal(id);
  if (!p) throw new AppError(CODES.NOT_FOUND, `Principal ${id} not found`);
  return p;
}

export async function listPrincipals(opts: {
  tenantId?: string;
  entityKind?: string;
  limit?: number;
  offset?: number;
}) {
  return principalRepo.listPrincipals(opts);
}

export async function addKey(
  principalId: string,
  keyId: string,
  publicKeyRaw: Buffer,
  publicKeyJwk: Record<string, unknown>,
  keyHash: string
) {
  // Verify principal exists
  await getPrincipal(principalId);
  try {
    return await principalRepo.addKey(principalId, keyId, publicKeyRaw, publicKeyJwk, keyHash);
  } catch (err: any) {
    if (err.code === '23505') {
      throw new AppError(CODES.CONFLICT, 'Key already registered (duplicate key_id or key_hash)');
    }
    throw err;
  }
}

export async function listKeys(principalId: string) {
  await getPrincipal(principalId); // verify exists
  return principalRepo.listKeys(principalId);
}

export async function createIssuer(principalId: string, trustWeight?: number) {
  assertTrustWeightInRange(trustWeight);
  const p = await getPrincipal(principalId);
  if (p.entity_kind === 'agent') {
    await principalRepo.updatePrincipal(principalId, { entity_kind: 'both' });
  }
  return principalRepo.createIssuer(principalId, trustWeight);
}
