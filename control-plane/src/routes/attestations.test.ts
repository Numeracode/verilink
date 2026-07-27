import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireScope } from '../middleware/requireScope.js';

function resolveCallerTenantIds(user: {
  tenantIds?: string[];
  tenantId?: string | null;
  roles?: string[];
}): string[] {
  const tenantIds = user.tenantIds || (user.tenantId ? [user.tenantId] : []);
  const roles = user.roles || [];
  if (roles.length > 0) {
    return tenantIds.filter((_, i) => roles[i] === 'staff' || roles[i] === 'admin');
  }
  return tenantIds;
}

describe('resolveCallerTenantIds — tenant-role pairing with API-key fallback', () => {
  it('API key user: tenantId passes through unfiltered (no roles array)', () => {
    const callerTenantIds = resolveCallerTenantIds({
      tenantId: 'tenant-a',
      roles: [],
    });
    assert.equal(callerTenantIds.length, 1);
    assert.equal(callerTenantIds[0], 'tenant-a');
  });

  it('OIDC tenant admin: elevated-role tenant included', () => {
    const callerTenantIds = resolveCallerTenantIds({
      tenantIds: ['tenant-a', 'tenant-b'],
      roles: ['admin', 'member'],
    });
    assert.equal(callerTenantIds.length, 1);
    assert.equal(callerTenantIds[0], 'tenant-a');
  });

  it('OIDC member-only user: no elevated roles → empty (public only)', () => {
    const callerTenantIds = resolveCallerTenantIds({
      tenantIds: ['tenant-a'],
      roles: ['member'],
    });
    assert.equal(callerTenantIds.length, 0);
  });

  it('OIDC platform staff: all elevated-role tenants included', () => {
    const callerTenantIds = resolveCallerTenantIds({
      tenantIds: ['tenant-a', 'tenant-b', 'tenant-c'],
      roles: ['admin', 'member', 'staff'],
    });
    assert.equal(callerTenantIds.length, 2);
    assert(callerTenantIds.includes('tenant-a'));
    assert(callerTenantIds.includes('tenant-c'));
  });

  it('API key with tenantId but no roles array does not lose tenant access', () => {
    const callerTenantIds = resolveCallerTenantIds({
      tenantId: 'tenant-x',
      roles: [],
    });
    assert(callerTenantIds.includes('tenant-x'));
  });

  it('user with no tenant context returns empty array', () => {
    const callerTenantIds = resolveCallerTenantIds({
      tenantIds: [],
      roles: ['admin'],
    });
    assert.equal(callerTenantIds.length, 0);
  });
});

describe('requireScope — API key scope enforcement', () => {
  it('API key with attest:read scope CAN access', () => {
    const req = {
      user: {
        type: 'apikey',
        apiKeyId: 'key-1',
        tenantId: 'tenant-a',
        scopes: ['attest:read'],
      },
    } as any;
    const next = (err?: any) => {
      if (err) throw err;
    };
    requireScope('attest:read')(req, {} as any, next);
  });

  it('API key without attest:read scope CANNOT access', () => {
    const req = {
      user: {
        type: 'apikey',
        apiKeyId: 'key-2',
        tenantId: 'tenant-a',
        scopes: ['attest:write'],
      },
    } as any;
    const errors: Error[] = [];
    const next = (err?: any) => {
      if (err) errors.push(err);
    };
    requireScope('attest:read')(req, {} as any, next);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Missing required scope: attest:read');
  });
});