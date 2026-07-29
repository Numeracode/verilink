// control-plane/src/domains/graph/attestationGraphLoader.ts
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { groupAttestationsForScoring } from './observationGrouping.js';

const HALF_LIVES_MS = 1800 * 24 * 60 * 60 * 1000;

export interface GraphPrincipal {
  id: string;
  entity_kind: string;
  trust_weight: number;
  is_bootstrap: boolean;
}

export interface GraphRoot {
  id: string;
  weight: number;
}

export interface GraphAttestation {
  id: string;
  issuer_id: string;
  subject_id: string;
  trust_delta: number;
  issued_at: Date;
  expires_at: Date | null;
  attestation_type: string;
  observation_id: string | null;
  visibility: string;
}

export interface AttestationGraph {
  principals: GraphPrincipal[];
  roots: GraphRoot[];
  attestations: GraphAttestation[];
  /** Count of network_scores rows from the same snapshot as the graph. */
  networkScoreCount: number;
}

interface AttestationRow {
  id: string;
  issuer_id: string;
  subject_id: string;
  trust_delta: number;
  issued_at: Date;
  expires_at: Date | null;
  attestation_type: string;
  observation_id: string | null;
  visibility: string;
}

interface RootRow {
  principal_id: string;
  current_weight: string;
  entity_kind: string;
}

interface IssuerMetaRow {
  principal_id: string;
  trust_weight: string;
  is_bootstrap: boolean;
  entity_kind: string;
  status: string;
}

/**
 * Load the active scoring graph for a single captured evaluationTime.
 * All reads share one REPEATABLE READ transaction so roots/attestations/
 * principals/score-count cannot tear across pool connections.
 * Never uses SQL now() for expiry / half-life predicates.
 */
export async function loadAttestationGraph(evaluationTime: Date): Promise<AttestationGraph> {
  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return loadAttestationGraphWithClient(client, evaluationTime);
  });
}

export async function loadAttestationGraphWithClient(
  client: pg.PoolClient,
  evaluationTime: Date
): Promise<AttestationGraph> {
  const halfLifeCutoff = new Date(evaluationTime.getTime() - HALF_LIVES_MS);

  const { rows: rootRows } = await client.query<RootRow>(
    `SELECT b.principal_id, b.current_weight, p.entity_kind
     FROM bootstrap_issuers b
     JOIN issuers i ON i.principal_id = b.principal_id
     JOIN principals p ON p.id = b.principal_id
     WHERE p.status = 'active'`
  );

  const roots: GraphRoot[] = rootRows.map((r) => ({
    id: r.principal_id,
    weight: parseFloat(r.current_weight),
  }));

  const { rows: attRows } = await client.query<AttestationRow>(
    `SELECT a.id, a.issuer_id, a.subject_id, a.trust_delta, a.issued_at, a.expires_at,
            a.attestation_type, a.observation_id, a.visibility
     FROM attestations a
     JOIN principals pi ON pi.id = a.issuer_id AND pi.status = 'active'
     JOIN principals ps ON ps.id = a.subject_id AND ps.status = 'active'
     WHERE a.superseded_by IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > $1)
       AND a.issued_at > $2`,
    [evaluationTime, halfLifeCutoff]
  );

  const attestations = groupAttestationsForScoring(attRows);

  const neededIds = new Set<string>();
  for (const r of roots) neededIds.add(r.id);
  for (const a of attestations) {
    neededIds.add(a.issuer_id);
    neededIds.add(a.subject_id);
  }

  const { rows: countRows } = await client.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM network_scores'
  );
  const networkScoreCount = parseInt(countRows[0].n, 10);

  if (neededIds.size === 0) {
    return { principals: [], roots: [], attestations: [], networkScoreCount };
  }

  const ids = [...neededIds];
  const { rows: principalRows } = await client.query<IssuerMetaRow>(
    `SELECT p.id AS principal_id, p.entity_kind, p.status,
            COALESCE(i.trust_weight, 1.0) AS trust_weight,
            COALESCE(i.is_bootstrap, false) AS is_bootstrap
     FROM principals p
     LEFT JOIN issuers i ON i.principal_id = p.id
     WHERE p.id = ANY($1::text[])
       AND p.status = 'active'`,
    [ids]
  );

  const rootSet = new Set(roots.map((r) => r.id));
  const principals: GraphPrincipal[] = principalRows.map((r) => {
    const isRoot = rootSet.has(r.principal_id);
    return {
      id: r.principal_id,
      entity_kind: r.entity_kind,
      // Bootstrap principals streamed as roots must have trust_weight=1.0 (gRPC contract).
      trust_weight: isRoot ? 1.0 : parseFloat(r.trust_weight),
      is_bootstrap: isRoot,
    };
  });

  const activeIds = new Set(principals.map((p) => p.id));
  const filteredAttestations = attestations.filter(
    (a) => activeIds.has(a.issuer_id) && activeIds.has(a.subject_id)
  );
  const filteredRoots = roots.filter((r) => activeIds.has(r.id));

  return {
    principals,
    roots: filteredRoots,
    attestations: filteredAttestations,
    networkScoreCount,
  };
}
