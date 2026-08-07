import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectActiveMembership } from './activeMembership.js';
import { AppError } from '../shared/errors/AppError.js';

describe('selectActiveMembership', () => {
  const memberships = [
    { tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'member' },
    { tenant_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'admin' },
  ];

  it('falls back to the first membership when no header is sent', () => {
    assert.deepEqual(selectActiveMembership(memberships, undefined), {
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      role: 'member',
    });
  });

  it('selects the requested membership with its role', () => {
    assert.deepEqual(
      selectActiveMembership(memberships, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      { tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'admin' }
    );
  });

  it('throws 403 when the requested tenant is not a membership', () => {
    assert.throws(
      () => selectActiveMembership(memberships, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });

  it('returns null tenant when the user has no memberships', () => {
    assert.deepEqual(selectActiveMembership([], undefined), {
      tenantId: null,
      role: 'member',
    });
  });

  it('throws 403 when a membership-less user sends a tenant header', () => {
    assert.throws(
      () => selectActiveMembership([], 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      /membership/
    );
  });
});
