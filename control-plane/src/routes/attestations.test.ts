import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCallerTenantIds } from '../lib/tenantFilter.js';

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

  it('undefined user returns empty array', () => {
    const callerTenantIds = resolveCallerTenantIds(undefined);
    assert.equal(callerTenantIds.length, 0);
  });
});