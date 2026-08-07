import { ApiError, apiFetch } from './client';
import type { AggregateItem } from '../lib/aggregates';

/** Typed fetchers for the Plan 9 PR B provider read APIs. */

interface Envelope<T> {
  ok: true;
  data: T;
}

export interface SampleRow {
  id: string;
  edge_node_id: string;
  wal_seq: string;
  fingerprint: string;
  principal_id: string | null;
  score: number | null;
  blacklisted: boolean | null;
  score_reason: string | null;
  action: string;
  decided_at: string;
}

export interface AgentRow {
  principal_id: string;
  name: string | null;
  entity_kind: string | null;
  decisions: number;
  last_decided_at: string;
  score: number | null;
  blacklisted: boolean | null;
  score_reason: string | null;
  score_computed_at: string | null;
}

export interface EdgeNodeRow {
  id: string;
  name: string;
  status: string;
  last_seen_at: string | null;
  last_sync_version: string | null;
  created_at: string;
  last_cursor: string | null;
  last_sync_at: string | null;
  high_water_version: string;
  lag: string;
}

export interface Policy {
  id: string;
  tenant_id: string;
  name: string;
  threshold: number;
  below_threshold_action: string;
  unsigned_action: string;
  allow_fingerprints: string[];
  deny_fingerprints: string[];
  fail_open_expired: boolean;
  no_drop_decisions: boolean;
  max_snapshot_age_seconds: number;
  allow_sample_rate: number;
  is_active: boolean;
  created_at: string;
}

export interface GraphSummary {
  principals: { total: number; agents: number; issuers: number; both: number };
  attestations: { total: number };
  top_issuers: Array<{
    issuer_id: string;
    name: string | null;
    trust_weight: number;
    verified_at: string | null;
    outgoing: number;
  }>;
  latest_score_computed_at: string | null;
}

export async function fetchAggregates(dimension: 'all' | 'principal' | 'fingerprint' = 'all') {
  const res = await apiFetch<Envelope<{ dimension: string; items: AggregateItem[] }>>(
    `/v1/decisions/aggregates?dimension=${dimension}`
  );
  return res.data.items;
}

export async function fetchSamples(limit = 50): Promise<SampleRow[]> {
  const res = await apiFetch<Envelope<{ items: SampleRow[] }>>(
    `/v1/decisions/samples?limit=${limit}`
  );
  return res.data.items;
}

export async function fetchAgents(limit = 100): Promise<AgentRow[]> {
  const res = await apiFetch<Envelope<{ items: AgentRow[] }>>(
    `/v1/decisions/agents?limit=${limit}`
  );
  return res.data.items;
}

export async function fetchEdgeNodes(): Promise<EdgeNodeRow[]> {
  const res = await apiFetch<Envelope<{ items: EdgeNodeRow[] }>>('/v1/edge-nodes');
  return res.data.items;
}

export async function fetchGraphSummary(): Promise<GraphSummary> {
  const res = await apiFetch<Envelope<GraphSummary>>('/v1/graph/summary');
  return res.data;
}

/** Active policy for the caller tenant; null when none exists (404). */
export async function fetchActivePolicy(): Promise<Policy | null> {
  try {
    const res = await apiFetch<Envelope<{ policy: Policy }>>('/v1/policies/active');
    return res.data.policy;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
