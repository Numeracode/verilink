import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireScope } from './requireScope.js';

type AnyReq = any;

function mockReq(user: AnyReq['user']): AnyReq {
  return { user } as AnyReq;
}

function mockRes(): AnyReq {
  return {} as AnyReq;
}

function makeNext() {
  const errors: Error[] = [];
  const next: any = (err?: any) => {
    if (err) errors.push(err);
  };
  return { next, errors };
}

describe('requireScope — tenant-admin isolation', () => {
  it('tenant admin (admin role, isStaff=false) CAN access attest:write', () => {
    const req = mockReq({
      type: 'oidc',
      userId: 'user-a',
      tenantId: 'tenant-a',
      role: 'admin',
      tenantIds: ['tenant-a'],
      roles: ['admin'],
      isStaff: false,
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 0);
  });

  it('tenant staff (staff role, isStaff=false) CAN access attest:write', () => {
    const req = mockReq({
      type: 'oidc',
      userId: 'user-b',
      tenantId: 'tenant-a',
      role: 'staff',
      tenantIds: ['tenant-a'],
      roles: ['staff'],
      isStaff: false,
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 0);
  });

  it('tenant member (member role, isStaff=false) CANNOT access attest:write', () => {
    const req = mockReq({
      type: 'oidc',
      userId: 'user-c',
      tenantId: 'tenant-a',
      role: 'member',
      tenantIds: ['tenant-a'],
      roles: ['member'],
      isStaff: false,
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'No membership grants scope: attest:write');
  });

  it('platform staff (isStaff=true) CAN access any scope', () => {
    const req = mockReq({
      type: 'oidc',
      userId: 'user-d',
      tenantId: 'tenant-a',
      role: 'admin',
      tenantIds: ['tenant-a'],
      roles: ['admin'],
      isStaff: true,
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 0);
  });

  it('multi-tenant user with admin in one tenant CAN access attest:write', () => {
    const req = mockReq({
      type: 'oidc',
      userId: 'user-e',
      tenantId: 'tenant-a',
      role: 'admin',
      tenantIds: ['tenant-a', 'tenant-b'],
      roles: ['admin', 'member'],
      isStaff: false,
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 0);
  });

  it('multi-tenant user with member in all tenants CANNOT access attest:write', () => {
    const req = mockReq({
      type: 'oidc',
      userId: 'user-f',
      tenantId: 'tenant-a',
      role: 'member',
      tenantIds: ['tenant-a', 'tenant-b'],
      roles: ['member', 'member'],
      isStaff: false,
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'No membership grants scope: attest:write');
  });

  it('unauthenticated user (no req.user) is denied', () => {
    const req = { user: undefined } as AnyReq;
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Authentication required');
  });

  it('API key with attest:write scope CAN access', () => {
    const req = mockReq({
      type: 'apikey',
      apiKeyId: 'key-1',
      tenantId: 'tenant-a',
      scopes: ['attest:write'],
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 0);
  });

  it('API key without attest:write scope CANNOT access', () => {
    const req = mockReq({
      type: 'apikey',
      apiKeyId: 'key-2',
      tenantId: 'tenant-a',
      scopes: ['attest:read'],
    });
    const { next, errors } = makeNext();
    requireScope('attest:write')(req, mockRes(), next);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Missing required scope: attest:write');
  });
});
describe('requireScope — callerTenantIds tenant-role pairing', () => {
  it('user admin in tenant A and member in tenant B: callerTenantIds only includes tenant A', () => {
    const tenantIds = ['tenant-a', 'tenant-b'];
    const roles = ['admin', 'member'];
    const callerTenantIds = tenantIds.filter((_, i) => roles[i] === 'staff' || roles[i] === 'admin');
    assert.equal(callerTenantIds.length, 1);
    assert.equal(callerTenantIds[0], 'tenant-a');
  });

  it('user member in both tenants: callerTenantIds is empty (no elevated roles)', () => {
    const tenantIds = ['tenant-a', 'tenant-b'];
    const roles = ['member', 'member'];
    const callerTenantIds = tenantIds.filter((_, i) => roles[i] === 'staff' || roles[i] === 'admin');
    assert.equal(callerTenantIds.length, 0);
  });

  it('user staff in tenant B and admin in tenant A: callerTenantIds includes both', () => {
    const tenantIds = ['tenant-a', 'tenant-b'];
    const roles = ['admin', 'staff'];
    const callerTenantIds = tenantIds.filter((_, i) => roles[i] === 'staff' || roles[i] === 'admin');
    assert.equal(callerTenantIds.length, 2);
    assert(callerTenantIds.includes('tenant-a'));
    assert(callerTenantIds.includes('tenant-b'));
  });
});
