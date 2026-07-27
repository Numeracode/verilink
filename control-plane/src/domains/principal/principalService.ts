// control-plane/src/domains/principal/principalService.ts
import { randomUUID } from 'node:crypto';
import * as principalRepo from './principalRepository.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { withTransaction } from '../../db/transaction.js';

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
  // Check key_hash uniqueness
  const existing = await principalRepo.getKeyByHash(keyHash);
  if (existing) {
    throw new AppError(CODES.CONFLICT, 'Key hash already registered to another principal');
  }
  return principalRepo.addKey(principalId, keyId, publicKeyRaw, publicKeyJwk, keyHash);
}

export async function listKeys(principalId: string) {
  await getPrincipal(principalId); // verify exists
  return principalRepo.listKeys(principalId);
}

export async function createIssuer(principalId: string, trustWeight?: number) {
  const p = await getPrincipal(principalId);
  if (p.entity_kind === 'agent') {
    // Upgrade to 'both'
    // (In v1, we just create the issuer record — entity_kind stays as-is
    //  because the principal was created with the right kind by the caller)
  }
  return principalRepo.createIssuer(principalId, trustWeight);
}
