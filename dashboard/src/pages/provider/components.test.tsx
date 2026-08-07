import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StalenessBanner } from './StalenessBanner';
import { AgentList } from './AgentList';
import { DecisionFeed } from './DecisionFeed';
import type { AgentRow, SampleRow } from '../../api/provider';

describe('StalenessBanner', () => {
  it('renders the banner when stale', () => {
    render(<StalenessBanner show={true} />);
    expect(screen.getByRole('status').textContent).toContain('Scores may be stale');
  });

  it('renders nothing when fresh', () => {
    const { container } = render(<StalenessBanner show={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('AgentList', () => {
  const base: AgentRow = {
    principal_id: 'vrl:p:11111111-2222-3333-4444-555555555555',
    name: 'booking-agent',
    entity_kind: 'agent',
    decisions: 17,
    last_decided_at: '2026-08-07T10:00:00Z',
    score: 12,
    blacklisted: true,
    score_reason: 'blacklisted',
    score_computed_at: '2026-08-07T09:00:00Z',
  };

  it('surfaces blacklisted from the score row, not inferred', () => {
    render(<AgentList agents={[base]} />);
    expect(screen.getByText('blacklisted')).toBeTruthy();
    expect(screen.getByText('booking-agent')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
  });

  it('shows unscored agents without a blacklist badge', () => {
    render(
      <AgentList
        agents={[{ ...base, blacklisted: null, score: null, score_reason: null }]}
      />
    );
    expect(screen.getByText('unscored')).toBeTruthy();
    expect(screen.queryByText('blacklisted')).toBeNull();
  });

  it('does not infer blacklist from a zero score', () => {
    render(
      <AgentList agents={[{ ...base, score: 0, blacklisted: false, score_reason: 'propagated' }]} />
    );
    expect(screen.queryByText('blacklisted')).toBeNull();
    expect(screen.getByText('propagated')).toBeTruthy();
  });

  it('renders an empty state', () => {
    render(<AgentList agents={[]} />);
    expect(screen.getByText(/No agents observed/)).toBeTruthy();
  });
});

describe('DecisionFeed', () => {
  const sample: SampleRow = {
    id: '42',
    edge_node_id: 'edge-1',
    wal_seq: '7',
    fingerprint: 'abcdef0123456789',
    principal_id: 'vrl:p:11111111-2222-3333-4444-555555555555',
    score: 55,
    blacklisted: false,
    score_reason: 'propagated',
    action: 'deny',
    decided_at: '2026-08-07T10:00:00Z',
  };

  it('renders action badges and scores', () => {
    render(<DecisionFeed samples={[sample]} />);
    expect(screen.getByText('deny')).toBeTruthy();
    expect(screen.getByText('55')).toBeTruthy();
    expect(screen.getByText('propagated')).toBeTruthy();
  });

  it('renders an empty state', () => {
    render(<DecisionFeed samples={[]} />);
    expect(screen.getByText(/No sampled decisions/)).toBeTruthy();
  });
});
