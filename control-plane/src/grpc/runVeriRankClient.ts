// control-plane/src/grpc/runVeriRankClient.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { config } from '../config.js';
import type {
  AttestationGraph,
  GraphAttestation,
  GraphPrincipal,
  GraphRoot,
} from '../domains/graph/attestationGraphLoader.js';
import type { EngineScore } from '../domains/graph/scoreDiff.js';

const PROTO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../proto/verilink/trust/v1/trust.proto'
);

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = grpc.loadPackageDefinition(packageDefinition) as any;
const TrustEngine = proto.verilink.trust.v1.TrustEngine as grpc.ServiceClientConstructor;

export interface RunVeriRankResult {
  rows: EngineScore[];
  computedAtUnix: number;
}

function toUnix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function mapAttestation(a: GraphAttestation) {
  return {
    issuerId: a.issuer_id,
    subjectId: a.subject_id,
    trustDelta: a.trust_delta,
    issuedAtUnix: toUnix(a.issued_at),
    expiresAtUnix: a.expires_at ? toUnix(a.expires_at) : 0,
    attestationType: a.attestation_type,
    observationId: a.observation_id || '',
  };
}

function mapPrincipal(p: GraphPrincipal) {
  return {
    id: p.id,
    entityKind: p.entity_kind,
    trustWeight: p.trust_weight,
    isBootstrap: p.is_bootstrap,
  };
}

function mapRoot(r: GraphRoot) {
  return {
    id: r.id,
    weight: r.weight,
  };
}

export function runVeriRank(
  graph: AttestationGraph,
  evaluationTime: Date,
  addr: string = config.trustEngine.addr
): Promise<RunVeriRankResult> {
  const client = new TrustEngine(addr, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
  });

  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + 60_000);
    const call = client.RunVeriRank({}, { deadline }, (err: Error | null, res: any) => {
      client.close();
      if (err) {
        reject(err);
        return;
      }
      const rows: EngineScore[] = (res?.rows || []).map((r: any) => ({
        principal_id: String(r.principalId ?? r.principal_id),
        entity_kind: String(r.entityKind ?? r.entity_kind),
        score: Number(r.score),
        blacklisted: Boolean(r.blacklisted),
        score_reason: String(r.scoreReason ?? r.score_reason),
      }));
      resolve({
        rows,
        computedAtUnix: Number(res?.computedAtUnix ?? res?.computed_at_unix ?? toUnix(evaluationTime)),
      });
    });

    call.on('error', (err: Error) => {
      client.close();
      reject(err);
    });

    call.write({ header: { evaluationTimeUnix: toUnix(evaluationTime) } });
    for (const p of graph.principals) {
      call.write({ principal: mapPrincipal(p) });
    }
    for (const r of graph.roots) {
      call.write({ root: mapRoot(r) });
    }
    for (const a of graph.attestations) {
      call.write({ attestation: mapAttestation(a) });
    }
    call.end();
  });
}

export async function runVeriRankWithRetry(
  graph: AttestationGraph,
  evaluationTime: Date,
  opts: { retries?: number; addr?: string } = {}
): Promise<RunVeriRankResult> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await runVeriRank(graph, evaluationTime, opts.addr);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
  }
  throw lastErr;
}
