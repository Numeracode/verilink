import { describe, it } from 'node:test';
import assert from 'node:assert';
import { canonicalize, computeFactsHash } from './canonicalize.js';

describe('RFC 8785 JCS canonicalize (production code)', () => {
  it('sorts keys by UTF-16 code unit order (uppercase before lowercase)', () => {
    const canonical = canonicalize({ b: 1, a: 2, Z: 3, A: 4 });
    assert.strictEqual(canonical, '{"A":4,"Z":3,"a":2,"b":1}');
  });

  it('produces deterministic hash regardless of insertion order', () => {
    const h1 = computeFactsHash({ z: 1, a: 2, m: 3 });
    const h2 = computeFactsHash({ a: 2, m: 3, z: 1 });
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

  it('is not locale-dependent (A before a)', () => {
    const canonical = canonicalize({ a: 1, A: 2 });
    assert.strictEqual(canonical, '{"A":2,"a":1}');
  });

  it('handles numbers (integer stays integer)', () => {
    assert.strictEqual(canonicalize({ n: 42 }), '{"n":42}');
  });

  it('handles booleans and null', () => {
    assert.strictEqual(canonicalize({ b: true, n: null }), '{"b":true,"n":null}');
  });

  it('handles empty object and array', () => {
    assert.strictEqual(canonicalize({}), '{}');
    assert.strictEqual(canonicalize({ a: [] }), '{"a":[]}');
  });

  it('produces stable hash across different key orders in nested objects', () => {
    const h1 = computeFactsHash({ a: { z: 1, b: 2 }, c: 3 });
    const h2 = computeFactsHash({ c: 3, a: { b: 2, z: 1 } });
    assert.strictEqual(h1, h2);
  });
});