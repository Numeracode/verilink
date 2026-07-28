// control-plane/src/domains/attestation/legacyConfig.ts

export function getV0Allowlist(): string[] {
  return (process.env.BEHAVIORAL_V0_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isV0AllowedForIssuer(issuerId: string): boolean {
  const allowlist = getV0Allowlist();
  if (allowlist.length === 0) return false;
  return allowlist.includes(issuerId);
}

export function isV0CutoffPassed(): boolean {
  const cutoff = process.env.BEHAVIORAL_V0_CUTOFF;
  if (!cutoff) return true;
  const cutoffTime = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffTime)) return true;
  return Date.now() > cutoffTime;
}