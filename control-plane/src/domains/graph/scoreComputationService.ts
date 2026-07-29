// control-plane/src/domains/graph/scoreComputationService.ts
import { logger } from '../../shared/logger.js';
import { runVeriRankWithRetry } from '../../grpc/runVeriRankClient.js';
import { loadAttestationGraph } from './attestationGraphLoader.js';
import { applyScoreTable, clearAllScores } from './scoreWriter.js';

export interface RecomputeResult {
  status: 'cold_start' | 'cleared_stale' | 'applied';
  upserts: number;
  deletes: number;
  evaluationTime: Date;
}

/**
 * Capture one evaluationTime and run loader → RunVeriRank → writer.
 * Empty eligible roots: cold-start no-op vs clear existing scores.
 * Graph load uses one REPEATABLE READ snapshot (including score count).
 */
export async function recomputeNow(
  evaluationTime: Date = new Date(),
  opts: { trustEngineAddr?: string } = {}
): Promise<RecomputeResult> {
  const graph = await loadAttestationGraph(evaluationTime);

  if (graph.roots.length === 0) {
    if (graph.networkScoreCount === 0) {
      logger.warn({ evaluationTime }, 'score recompute: no eligible bootstrap roots (cold start)');
      return { status: 'cold_start', upserts: 0, deletes: 0, evaluationTime };
    }
    logger.warn(
      { evaluationTime, existing: graph.networkScoreCount },
      'score recompute: no eligible bootstrap roots — clearing stale scores'
    );
    const deletes = await clearAllScores();
    return { status: 'cleared_stale', upserts: 0, deletes, evaluationTime };
  }

  const result = await runVeriRankWithRetry(graph, evaluationTime, {
    addr: opts.trustEngineAddr,
  });
  const computedAt = new Date(result.computedAtUnix * 1000);
  const applied = await applyScoreTable(result.rows, computedAt);
  return {
    status: 'applied',
    upserts: applied.upserts,
    deletes: applied.deletes,
    evaluationTime,
  };
}
