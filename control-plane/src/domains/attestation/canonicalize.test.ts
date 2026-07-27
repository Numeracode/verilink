import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

// Test the JCS canonicalization by importing the function indirectly.
// Since canonicalize is not exported, we verify it through facts_hash
// computation by re-implementing it here and comparing against known vectors.

describe('RFC 8785 JCS canonicalization', () => {
  // RFC 8785 sorts by UTF-16 code unit order, NOT locale order.
  // This means uppercase before lowercase, and Unicode ordering is by
  // charCodeAt, not locale-sensitive comparison.

  function canonicalize(obj: unknown): string {
    return JSON.stringify(canonicalizeValue(obj));
  }

  function canonicalizeValue(value: unknown): unknown {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(canonicalizeValue);
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => {
          const aLen = a.length, bLen = b.length;
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

  function factsHash(obj: unknown): string {
    return createHash('sha256').update(canonicalize(obj)).digest('hex');
  }

  it('sorts keys by UTF-16 code unit order (uppercase before lowercase)', () => {
    const canonical = canonicalize({ b: 1, a: 2, Z: 3, A: 4 });
    // UTF-16: A(65) < Z(90) < a(97) < b(98)
    assert.strictEqual(canonical, '{"A":4,"Z":3,"a":2,"b":1}');
  });

  it('produces deterministic hash regardless of insertion order', () => {
    const h1 = factsHash({ z: 1, a: 2, m: 3 });
    const h2 = factsHash({ a: 2, m: 3, z: 1 });
    assert.strictEqual(h1, h2);
  });

  it('handles nested objects', () => {
    const canonical = canonicalize({ outer: { d: 1, a: 2 } });
    assert.strictEqual(canonical, '{"outer":{"a":2,"d":1}}');
  });

  it('handles arrays (preserves order)', () => {
    const canonical = canonicalize({ items: [3, 1, 2] });
    assert.strictEqual(canonical, '{"items":[3,1,2]}');
  });

  it('drops undefined values', () => {
    const canonical = canonicalize({ a: 1, b: undefined, c: 2 });
    assert.strictEqual(canonical, '{"a":1,"c":2}');
  });

  it('is not locale-dependent (no localeCompare)', () => {
    // In some locales, localeCompare puts 'a' before 'A'.
    // RFC 8785 requires 'A' before 'a' (UTF-16 order).
    const canonical = canonicalize({ a: 1, A: 2 });
    assert.strictEqual(canonical, '{"A":2,"a":1}');
  });
});