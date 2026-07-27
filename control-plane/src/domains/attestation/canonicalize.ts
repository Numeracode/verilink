// control-plane/src/domains/attestation/canonicalize.ts
// RFC 8785 JSON Canonicalization Scheme (JCS)
// Sorts object properties by UTF-16 code unit order (not locale-dependent).

import { createHash } from 'node:crypto';

export function canonicalize(obj: unknown): string {
  return JSON.stringify(canonicalizeValue(obj));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => {
        const aLen = a.length;
        const bLen = b.length;
        const minLen = Math.min(aLen, bLen);
        for (let i = 0; i < minLen; i++) {
          if (a.charCodeAt(i) !== b.charCodeAt(i)) {
            return a.charCodeAt(i) - b.charCodeAt(i);
          }
        }
        return aLen - bLen;
      });
    const result: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (v !== undefined) result[k] = canonicalizeValue(v);
    }
    return result;
  }
  return value;
}

export function computeFactsHash(facts: unknown): string {
  return createHash('sha256').update(canonicalize(facts)).digest('hex');
}