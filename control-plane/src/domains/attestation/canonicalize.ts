// control-plane/src/domains/attestation/canonicalize.ts
// RFC 8785 JSON Canonicalization Scheme (JCS)
// Sorts object properties by UTF-16 code unit order (not locale-dependent).
// Serializes sorted entries directly to avoid JS engine integer-key reordering.

import { createHash } from 'node:crypto';

export function canonicalize(obj: unknown): string {
  return canonicalizeValue(obj);
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalizeNumber(value);
  if (typeof value === 'string') return canonicalizeString(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalizeValue(v));
    return '[' + items.join(',') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
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
    const pairs = entries.map(([k, v]) => canonicalizeString(k) + ':' + canonicalizeValue(v));
    return '{' + pairs.join(',') + '}';
  }
  return canonicalizeString(String(value));
}

function canonicalizeString(s: string): string {
  // RFC 8785 / I-JSON: reject lone surrogates
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — must be followed by a low surrogate
      if (i + 1 >= s.length || s.charCodeAt(i + 1) < 0xdc00 || s.charCodeAt(i + 1) > 0xdfff) {
        throw new Error('JCS: lone high surrogate in string (RFC 8785 violation)');
      }
      i++; // skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('JCS: lone low surrogate in string (RFC 8785 violation)');
    }
  }
  return JSON.stringify(s);
}

function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) return 'null';
  // RFC 8785: integers without decimal point, floats with shortest representation
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

export function computeFactsHash(facts: unknown): string {
  return createHash('sha256').update(canonicalize(facts)).digest('hex');
}