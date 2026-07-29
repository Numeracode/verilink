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

// Dynamic proto stubs — shape varies with proto-loader; keep local any.
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

/**
 * Wait for backpressure to clear without leaking listeners.
 * `once()` + `Promise.race` leaves the losing handlers attached; this cleans up.
 */
export function waitForDrainOrFailure(
  call: NodeJS.EventEmitter
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('gRPC stream closed before drain'));
    };
    const cleanup = () => {
      call.off('drain', onDrain);
      call.off('error', onError);
      call.off('close', onClose);
    };
    call.on('drain', onDrain);
    call.on('error', onError);
    call.on('close', onClose);
  });
}

async function writeChunk(
  call: grpc.ClientWritableStream<unknown>,
  chunk: unknown
): Promise<void> {
  if (call.write(chunk)) return;
  await waitForDrainOrFailure(call);
}

function deadlineForGraph(graph: AttestationGraph): Date {
  const n = graph.principals.length + graph.roots.length + graph.attestations.length;
  // Base 60s + 5ms per streamed chunk, capped at 10 minutes.
  const ms = Math.min(600_000, 60_000 + n * 5);
  return new Date(Date.now() + ms);
}

function isRetryableGrpcError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  const code = (err as { code?: number }).code;
  if (typeof code !== 'number') return true;
  switch (code) {
    case grpc.status.INVALID_ARGUMENT:
    case grpc.status.NOT_FOUND:
    case grpc.status.ALREADY_EXISTS:
    case grpc.status.PERMISSION_DENIED:
    case grpc.status.UNAUTHENTICATED:
    case grpc.status.FAILED_PRECONDITION:
    case grpc.status.OUT_OF_RANGE:
    case grpc.status.UNIMPLEMENTED:
      return false;
    default:
      return true;
  }
}

function grpcCredentialsFor(addr: string): grpc.ChannelCredentials {
  // TLS for non-local trust-engine addresses; insecure only for loopback MVP.
  const host = addr.split(':')[0]?.toLowerCase() ?? '';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return grpc.credentials.createInsecure();
  }
  return grpc.credentials.createSsl();
}

export function runVeriRank(
  graph: AttestationGraph,
  evaluationTime: Date,
  addr: string = config.trustEngine.addr
): Promise<RunVeriRankResult> {
  const client = new TrustEngine(addr, grpcCredentialsFor(addr), {
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        // ignore close errors after stream failure
      }
      fn();
    };

    const deadline = deadlineForGraph(graph);
    // First argument must be Metadata (not a plain {}), or grpc-js rejects the call.
    const metadata = new grpc.Metadata();
    const call = client.RunVeriRank(
      metadata,
      { deadline },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: Error | null, res: any) => {
        settle(() => {
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
            computedAtUnix: Number(
              res?.computedAtUnix ?? res?.computed_at_unix ?? toUnix(evaluationTime)
            ),
          });
        });
      }
    );

    call.on('error', (err: Error) => {
      settle(() => reject(err));
    });

    void (async () => {
      try {
        await writeChunk(call, { header: { evaluationTimeUnix: toUnix(evaluationTime) } });
        for (const p of graph.principals) {
          await writeChunk(call, { principal: mapPrincipal(p) });
        }
        for (const r of graph.roots) {
          await writeChunk(call, { root: mapRoot(r) });
        }
        for (const a of graph.attestations) {
          await writeChunk(call, { attestation: mapAttestation(a) });
        }
        call.end();
      } catch (err) {
        settle(() => reject(err));
      }
    })();
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
      if (attempt >= retries || !isRetryableGrpcError(err)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  throw lastErr;
}
