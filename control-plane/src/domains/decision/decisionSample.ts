/** Deterministic sample gate: all denies; allows/passthroughs at allow_sample_rate. */
export function shouldSample(action: string, walSeq: number, rate: number): boolean {
  if (action === 'deny') return true;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const bucket = ((walSeq % 10000) + 10000) % 10000;
  return bucket / 10000 < rate;
}
