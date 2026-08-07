import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrincipalList } from './PrincipalList';
import { KeyList } from './KeyList';
import { AttestationFeed } from './AttestationFeed';
import type { OwnedPrincipal, PrincipalKey, AttestationRow } from '../../api/agentBuilder';

describe('PrincipalList', () => {
  const base: OwnedPrincipal = {
    id: 'vrl:p:11111111-2222-3333-4444-555555555555',
    entity_kind: 'agent',
    name: 'checkout-agent',
    owner_tenant_id: null,
    assurance_level: 'verified_key',
    first_seen_at: '2026-08-07T00:00:00Z',
    last_seen_at: '2026-08-07T01:00:00Z',
    status: 'active',
  };

  it('renders principals and calls onSelect', () => {
    const onSelect = vi.fn();
    render(<PrincipalList principals={[base]} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('checkout-agent'));
    expect(onSelect).toHaveBeenCalledWith(base.id);
  });

  it('marks the selected principal', () => {
    render(<PrincipalList principals={[base]} selectedId={base.id} onSelect={() => {}} />);
    expect(screen.getByText('checkout-agent').closest('button')?.getAttribute('class')).toContain('is-selected');
  });

  it('shows an empty state', () => {
    render(<PrincipalList principals={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/No owned principals/)).toBeTruthy();
  });

  it('shows verified vs unverified assurance badges', () => {
    render(
      <PrincipalList
        principals={[
          { ...base, assurance_level: 'verified_key' },
          { ...base, id: 'vrl:p:other', name: 'other', assurance_level: 'unknown' },
        ]}
        selectedId={null}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText('verified key')).toBeTruthy();
    expect(screen.getByText('unverified')).toBeTruthy();
  });
});

describe('KeyList', () => {
  const key: PrincipalKey = {
    principal_id: 'vrl:p:1',
    key_id: 'k1',
    key_hash: 'abcdef0123456789abcdef0123456789',
    control_verified_at: '2026-08-07T00:00:00Z',
    valid_from: '2026-08-07T00:00:00Z',
    valid_until: null,
    revoked_at: null,
  };

  it('shows a verified key badge for a control-verified key', () => {
    render(<KeyList keys={[key]} />);
    expect(screen.getByText('verified')).toBeTruthy();
  });

  it('shows a revoked badge for a revoked key', () => {
    render(<KeyList keys={[{ ...key, revoked_at: '2026-08-08T00:00:00Z' }]} />);
    expect(screen.getAllByText('revoked').length).toBeGreaterThan(0);
  });

  it('shows control unverified when control_verified_at is null', () => {
    render(<KeyList keys={[{ ...key, control_verified_at: null }]} />);
    expect(screen.getByText('control unverified')).toBeTruthy();
  });

  it('renders an empty state', () => {
    render(<KeyList keys={[]} />);
    expect(screen.getByText(/No keys registered/)).toBeTruthy();
  });
});

describe('AttestationFeed', () => {
  const att: AttestationRow = {
    id: '11111111-1111-1111-1111-111111111111',
    issuer_id: 'vrl:p:issuer-aaaa',
    subject_id: 'vrl:p:subject-aaaa',
    attestation_type: 'transaction_summary',
    trust_delta: 10,
    visibility: 'public',
    issued_at: '2026-08-07T01:00:00Z',
    received_at: '2026-08-07T01:00:01Z',
  };

  it('renders incoming attestations with the counterparty label', () => {
    render(<AttestationFeed direction="in" items={[att]} />);
    expect(screen.getByText('transaction_summary')).toBeTruthy();
    expect(screen.getByText('+10')).toBeTruthy();
  });

  it('renders outgoing attestations', () => {
    render(<AttestationFeed direction="out" items={[att]} />);
    expect(screen.getByText('transaction_summary')).toBeTruthy();
  });

  it('renders an empty state', () => {
    render(<AttestationFeed direction="in" items={[]} />);
    expect(screen.getByText(/No incoming/)).toBeTruthy();
  });
});
