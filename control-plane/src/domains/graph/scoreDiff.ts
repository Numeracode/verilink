// control-plane/src/domains/graph/scoreDiff.ts

export interface ExistingScore {
  principal_id: string;
  entity_kind: string;
  score: number;
  blacklisted: boolean;
  score_reason: string;
}

export interface EngineScore {
  principal_id: string;
  entity_kind: string;
  score: number;
  blacklisted: boolean;
  score_reason: string;
}

export function scoreChanged(prev: ExistingScore, next: EngineScore): boolean {
  return (
    prev.score !== next.score ||
    prev.blacklisted !== next.blacklisted ||
    prev.score_reason !== next.score_reason ||
    prev.entity_kind !== next.entity_kind
  );
}
