import { describe, it } from 'node:test';
import assert from 'node:assert';
import { canonicalize, computeFactsHash } from './canonicalize.js';

describe('RFC 8785 JCS canonicalize (production code)', () => {
  it('sorts keys by UTF-16 code unit order (uppercase before lowercase)', () => {
    assert.strictEqual(canonicalize({ b: 1, a: 2, Z: 3, A: 4 }), '{"A":4,"Z":3,"a":2,"b":1}');
  });

  it('produces deterministic hash regardless of insertion order', () => {
    const h1 = computeFactsHash({ z: 1, a: 2, m: 3 });
    const h2 = computeFactsHash({ a: 2, m: 3, z: 1 });
    assert.strictEqual(h1, h2);
  });

  it('handles nested objects', () => {
    assert.strictEqual(canonicalize({ outer: { d: 1, a: 2 } }), '{"outer":{"a":2,"d":1}}');
  });

  it('handles arrays (preserves order)', () => {
    assert.strictEqual(canonicalize({ items: [3, 1, 2] }), '{"items":[3,1,2]}');
  });

  it('drops undefined values', () => {
    assert.strictEqual(canonicalize({ a: 1, b: undefined, c: 2 }), '{"a":1,"c":2}');
  });

  it('is not locale-dependent (A before a)', () => {
    assert.strictEqual(canonicalize({ a: 1, A: 2 }), '{"A":2,"a":1}');
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

  it('integer-like keys sorted by UTF-16 order, not numeric order', () => {
    // RFC 8785: "10" before "2" because '1' (charCode 49) < '2' (charCode 50)
    // JSON.stringify on a plain object would reorder these numerically ("2" before "10")
    assert.strictEqual(canonicalize({ '10': 'a', '2': 'b' }), '{"10":"a","2":"b"}');
  });

  it('mixed integer and string keys follow UTF-16 order', () => {
    assert.strictEqual(canonicalize({ '1': 'a', b: 'c', '10': 'd' }), '{"1":"a","10":"d","b":"c"}');
  });
});