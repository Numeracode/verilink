import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TenantList } from './TenantList';
import { GraphHealth } from './GraphHealth';
import { IssuerVerificationQueue } from './IssuerVerificationQueue';
import { BootstrapEditor } from './BootstrapEditor';
import type { TenantRow, BootstrapIssuer, UnverifiedIssuer } from '../../api/admin';
import type { GraphSummary } from '../../api/provider';

const tenant: TenantRow = {
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'acme',
  name: 'Acme',
  plan: 'pro',
  status: 'active',
  created_at: '2026-08-07T00:00:00Z',
};

describe('TenantList', () => {
  it('renders tenants', () => {
    render(<TenantList tenants={[tenant]} />);
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('pro')).toBeTruthy();
  });

  it('renders an empty state', () => {
    render(<TenantList tenants={[]} />);
    expect(screen.getByText(/No tenants visible/)).toBeTruthy();
  });
});

const summary: GraphSummary = {
  principals: { total: 10, agents: 7, issuers: 3, both: 1 },
  attestations: { total: 42 },
  top_issuers: [],
  latest_score_computed_at: '2026-08-07T01:00:00Z',
};

describe('GraphHealth', () => {
  it('renders the counts', () => {
    render(<GraphHealth summary={summary} />);
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('renders a loading state', () => {
    render(<GraphHealth summary={undefined} />);
    expect(screen.getByText(/Loading/)).toBeTruthy();
  });
});

const bootstrap: BootstrapIssuer = {
  principal_id: 'vrl:p:11111111-2222-3333-4444-555555555555',
  name: 'root-1',
  current_weight: 1,
  de_emphasis_reason: null,
  de_emphasized_at: null,
  approved_by: null,
  seeded_at: '2026-08-07T00:00:00Z',
  trust_weight: 1,
  verified_at: null,
};

describe('BootstrapEditor', () => {
  it('renders issuers with de-emphasis step buttons', () => {
    const onUpdate = vi.fn();
    render(<BootstrapEditor issuers={[bootstrap]} onUpdate={onUpdate} />);
    expect(screen.getByText('root-1')).toBeTruthy();
    // The current weight (1) renders in the weight column and the 1.0 step button.
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
  });

  it('renders an empty state', () => {
    render(<BootstrapEditor issuers={[]} onUpdate={() => Promise.resolve()} />);
    expect(screen.getByText(/No bootstrap issuers/)).toBeTruthy();
  });

  it('enables a reason-only save and calls onUpdate without changing weight', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<BootstrapEditor issuers={[bootstrap]} onUpdate={onUpdate} />);
    const input = screen.getByLabelText('De-emphasis reason');
    fireEvent.change(input, { target: { value: 'organic volume' } });
    const saveBtn = screen.getByRole('button', { name: 'Save reason' });
    await fireEvent.click(saveBtn);
    expect(onUpdate).toHaveBeenCalledWith(bootstrap.principal_id, { de_emphasis_reason: 'organic volume' });
  });
});

const unverified: UnverifiedIssuer = {
  principal_id: 'vrl:p:22222222-2222-2222-2222-222222222222',
  name: 'pending-issuer',
  entity_kind: 'issuer',
  trust_weight: 1,
  is_bootstrap: false,
  created_at: '2026-08-07T00:00:00Z',
};

describe('IssuerVerificationQueue', () => {
  it('renders unverified issuers', () => {
    render(<IssuerVerificationQueue issuers={[unverified]} />);
    expect(screen.getByText('pending-issuer')).toBeTruthy();
    expect(screen.getByText('issuer')).toBeTruthy();
  });

  it('renders an empty state', () => {
    render(<IssuerVerificationQueue issuers={[]} />);
    expect(screen.getByText(/No issuers awaiting verification/)).toBeTruthy();
  });
});
