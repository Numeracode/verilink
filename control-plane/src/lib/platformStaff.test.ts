import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPlatformStaff } from './platformStaff.js';

describe('isPlatformStaff', () => {
  it('treats OIDC platform staff as staff', () => {
    assert.equal(isPlatformStaff({ isStaff: true, type: 'oidc' }), true);
  });

  it('treats an admin:read API key as staff', () => {
    assert.equal(isPlatformStaff({ type: 'apikey', scopes: ['admin:read'] }), true);
  });

  it('treats a scoped tenant key as non-staff', () => {
    assert.equal(isPlatformStaff({ type: 'apikey', scopes: ['attest:read'] }), false);
  });

  it('treats a plain OIDC member as non-staff', () => {
    assert.equal(isPlatformStaff({ isStaff: false, type: 'oidc', scopes: [] }), false);
  });

  it('handles undefined user', () => {
    assert.equal(isPlatformStaff(undefined), false);
  });
});
