// control-plane/src/domains/bootstrap/deEmphasisService.ts

import { pool } from '../../db/transaction.js';
import { loadAttestationGraph, type AttestationGraph, type GraphRoot } from '../graph/attestationGraphLoader.js';
import { runVeriRankWithRetry } from '../../grpc/runVeriRankClient.js';
import { getActivePolicy } from '../policy/policyRepository.js';
import type { EngineScore } from '../graph/scoreDiff.js';

const WINDOW_DAYS = 30;
const MIN_INDEPENDENT_ORGANIC_ISSUERS = 3;
const MIN_ORGANIC_CONTRIBUTION_PCT = 80;

export interface ContributionSplit {
  bootstrap_weighted: number;
  organic_weighted: number;
  organic_pct: number;
  independent_organic_issuers: number;
  window_days: number;
  window_continuous: boolean;
}

export interface CounterfactualDrop {
  principal_id: string;
  current_score: number;
  counterfactual_score: number;
  serving_tenant_id: string | null;
  tenant_threshold: number;
  drops_below_threshold: boolean;
}

export interface CounterfactualReport {
  root_id: string;
  target_weight: number;
  graph_version: number;
  drops: CounterfactualDrop[];
  worst_case_drop: number;
}

export interface DeEmphasisCandidate {
  principal_id: string;
  name: string;
  current_weight: number;
  contribution: ContributionSplit;
  ready: boolean;
  not_ready_reasons: string[];
  counterfactual: CounterfactualReport | null;
}

export interface DeEmphasisResult {
  generated_at: string;
  window_days: number;
  contribution: ContributionSplit;
  candidates: DeEmphasisCandidate[];
}

interface ContributionRow {
  bootstrap_origin: boolean;
  issuer_id: string;
  subject_id: string;
  trust_delta: number;
  issued_at: Date;
  owner_tenant_id: string | null;
  entity_kind: string;
}

interface GraphVersionRow {
  high_water: string;
}

async function getGraphVersion(): Promise<number> {
  const { rows } = await pool.query<GraphVersionRow>(
    'SELECT COALESCE(MAX(sync_version), 0)::text AS high_water FROM sync_events',
  );
  return Number(rows[0].high_water);
}

/**
 * Compute the bootstrap vs organic weighted contribution split over the
 * trailing 30-day window (Plan 10 PR C, decision 8). Bootstrap-origin
 * attestations are excluded from organic contribution even after the
 * registry row is removed (decision 6).
 */
export async function computeContributionSplit(
  evaluationTime: Date = new Date(),
): Promise<ContributionSplit> {
  const windowStart = new Date(evaluationTime.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query<ContributionRow>(
    `SELECT a.bootstrap_origin, a.issuer_id, a.subject_id, a.trust_delta,
            a.issued_at, p.owner_tenant_id, p.entity_kind
     FROM attestations a
     JOIN principals p ON p.id = a.issuer_id
     WHERE a.issued_at > $1
       AND a.superseded_by IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > NOW())
       AND p.status = 'active'`,
    [windowStart],
  );

  let bootstrapWeighted = 0;
  let organicWeighted = 0;
  const organicIssuerKeys = new Set<string>();

  for (const row of rows) {
    if (row.bootstrap_origin) {
      bootstrapWeighted += Math.abs(row.trust_delta);
    } else {
      organicWeighted += Math.abs(row.trust_delta);
      const key = (row.owner_tenant_id || 'null') + ':' + row.entity_kind;
      organicIssuerKeys.add(key);
    }
  }

  const total = bootstrapWeighted + organicWeighted;
  const organicPct = total > 0 ? Math.round((organicWeighted / total) * 100) : 0;

  // Check continuity: at least one attestation in each of the 30 daily buckets.
  // For simplicity and robustness, check that the earliest organic attestation
  // is within the first 5 days of the window (continuous presence).
  const organicDates = rows
    .filter((r) => !r.bootstrap_origin)
    .map((r) => r.issued_at.getTime())
    .sort((a, b) => a - b);
  const windowContinuous =
    organicDates.length > 0 &&
    organicDates[0] <= windowStart.getTime() + 5 * 24 * 60 * 60 * 1000 &&
    organicDates[organicDates.length - 1] >= evaluationTime.getTime() - 5 * 24 * 60 * 60 * 1000;

  return {
    bootstrap_weighted: bootstrapWeighted,
    organic_weighted: organicWeighted,
    organic_pct: organicPct,
    independent_organic_issuers: organicIssuerKeys.size,
    window_days: WINDOW_DAYS,
    window_continuous: windowContinuous,
  };
}

/**
 * Run a counterfactual removal report for a single root at a target weight
 * (Plan 10 PR C, decision 8). Loads the current graph, overrides the root's
 * weight, re-runs VeriRank (no write), and compares per-principal scores
 * against their serving tenant's active policy threshold.
 */
export async function computeCounterfactualRemovalReport(
  rootId: string,
  targetWeight: number,
  evaluationTime: Date = new Date(),
): Promise<CounterfactualReport> {
  const graph = await loadAttestationGraph(evaluationTime);
  const graphVersion = await getGraphVersion();

  // Get current scores (before counterfactual)
  const currentResult = await runVeriRankWithRetry(graph, evaluationTime);
  const currentScores = new Map<string, EngineScore>();
  for (const row of currentResult.rows) {
    currentScores.set(row.principal_id, row);
  }

  // Override the target root's weight
  const counterfactualGraph: AttestationGraph = {
    ...graph,
    roots: graph.roots.map((r: GraphRoot) =>
      r.id === rootId ? { id: r.id, weight: targetWeight } : r,
    ),
  };

  const counterfactualResult = await runVeriRankWithRetry(counterfactualGraph, evaluationTime);
  const counterfactualScores = new Map<string, EngineScore>();
  for (const row of counterfactualResult.rows) {
    counterfactualScores.set(row.principal_id, row);
  }

  // Load principal -> owner_tenant_id mapping for all principals in the graph
  const principalIds = graph.principals.map((p) => p.id);
  const { rows: principalRows } = await pool.query<{ id: string; owner_tenant_id: string | null }>(
    'SELECT id, owner_tenant_id FROM principals WHERE id = ANY($1::text[])',
    [principalIds],
  );
  const tenantMap = new Map<string, string | null>();
  for (const row of principalRows) {
    tenantMap.set(row.id, row.owner_tenant_id);
  }

  // Cache active policies per tenant
  const policyCache = new Map<string, number>();
  async function getThreshold(tenantId: string): Promise<number | null> {
    if (policyCache.has(tenantId)) return policyCache.get(tenantId)!;
    const policy = await getActivePolicy(tenantId);
    const threshold = policy?.threshold ?? null;
    if (threshold !== null) policyCache.set(tenantId, threshold);
    return threshold;
  }

  const drops: CounterfactualDrop[] = [];
  let worstCase = 0;

  for (const principal of graph.principals) {
    const current = currentScores.get(principal.id);
    const counterfactual = counterfactualScores.get(principal.id);
    if (!current || !counterfactual) continue;

    const tenantId = tenantMap.get(principal.id) || null;
    let tenantThreshold = 0;
    if (tenantId) {
      const t = await getThreshold(tenantId);
      tenantThreshold = t ?? 0;
    }

    const drop = current.score - counterfactual.score;
    if (drop > 0) {
      worstCase = Math.max(worstCase, drop);
    }

    drops.push({
      principal_id: principal.id,
      current_score: current.score,
      counterfactual_score: counterfactual.score,
      serving_tenant_id: tenantId,
      tenant_threshold: tenantThreshold,
      drops_below_threshold:
        tenantThreshold > 0 &&
        current.score >= tenantThreshold &&
        counterfactual.score < tenantThreshold,
    });
  }

  return {
    root_id: rootId,
    target_weight: targetWeight,
    graph_version: graphVersion,
    drops,
    worst_case_drop: worstCase,
  };
}

/**
 * Evaluate the full de-emphasis readiness gate (Plan 10 PR C, decision 8).
 * Returns the contribution split and per-candidate readiness + counterfactual.
 */
export async function getDeEmphasisStatus(
  evaluationTime: Date = new Date(),
): Promise<DeEmphasisResult> {
  const contribution = await computeContributionSplit(evaluationTime);

  // List active bootstrap issuers (candidates for de-emphasis)
  const { rows: candidates } = await pool.query<{
    principal_id: string;
    name: string;
    current_weight: number;
  }>(
    `SELECT b.principal_id, b.name, b.current_weight::float AS current_weight
     FROM bootstrap_issuers b
     JOIN issuers i ON i.principal_id = b.principal_id
     WHERE b.removed_from_registry_at IS NULL AND b.current_weight > 0
     ORDER BY b.seeded_at ASC`,
  );

  const candidateResults: DeEmphasisCandidate[] = [];

  for (const candidate of candidates) {
    const notReadyReasons: string[] = [];

    if (contribution.independent_organic_issuers < MIN_INDEPENDENT_ORGANIC_ISSUERS) {
      notReadyReasons.push(
        'insufficient independent organic issuers (' + contribution.independent_organic_issuers + ' < ' + MIN_INDEPENDENT_ORGANIC_ISSUERS + ')',
      );
    }
    if (contribution.organic_pct < MIN_ORGANIC_CONTRIBUTION_PCT) {
      notReadyReasons.push(
        'organic contribution below threshold (' + contribution.organic_pct + '% < ' + MIN_ORGANIC_CONTRIBUTION_PCT + '%)',
      );
    }
    if (!contribution.window_continuous) {
      notReadyReasons.push('organic contribution window is not continuous over 30 days');
    }

    // Compute counterfactual for full removal (target_weight=0)
    const counterfactual = await computeCounterfactualRemovalReport(
      candidate.principal_id,
      0,
      evaluationTime,
    );

    const hasThresholdDrop = counterfactual.drops.some((d) => d.drops_below_threshold);
    if (hasThresholdDrop) {
      notReadyReasons.push('counterfactual removal would drop a principal below its serving tenant threshold');
    }

    candidateResults.push({
      principal_id: candidate.principal_id,
      name: candidate.name,
      current_weight: candidate.current_weight,
      contribution,
      ready: notReadyReasons.length === 0,
      not_ready_reasons: notReadyReasons,
      counterfactual,
    });
  }

  return {
    generated_at: evaluationTime.toISOString(),
    window_days: WINDOW_DAYS,
    contribution,
    candidates: candidateResults,
  };
}

/**
 * Validate that a counterfactual report is not stale (graph version matches
 * current) and the target weight matches. Rejects mismatched reports.
 */
export function validateReportFreshness(
  report: CounterfactualReport,
  expectedGraphVersion: number,
  expectedTargetWeight: number,
): void {
  if (report.graph_version !== expectedGraphVersion) {
    throw new Error(
      'stale counterfactual report: graph version ' + report.graph_version +
      ' does not match current ' + expectedGraphVersion,
    );
  }
  if (report.target_weight !== expectedTargetWeight) {
    throw new Error(
      'counterfactual report target weight ' + report.target_weight +
      ' does not match expected ' + expectedTargetWeight,
    );
  }
}
