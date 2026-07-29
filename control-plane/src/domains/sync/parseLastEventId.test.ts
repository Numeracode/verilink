import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLastEventId } from './parseLastEventId.js';

describe('parseLastEventId', () => {
  it('omitted header and query → 0', () => {
    const r = parseLastEventId({ headerPresent: false, queryKeyPresent: false });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 0n);
  });

  it('explicit 0 via query → 0', () => {
    const r = parseLastEventId({
      headerPresent: false,
      queryKeyPresent: true,
      query: '0',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 0n);
  });

  it('header wins over query', () => {
    const r = parseLastEventId({
      headerPresent: true,
      header: '42',
      queryKeyPresent: true,
      query: '7',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 42n);
  });

  it('supplied-blank header → error', () => {
    const r = parseLastEventId({ headerPresent: true, header: '  ' });
    assert.equal(r.ok, false);
  });

  it('supplied-blank query → error', () => {
    const r = parseLastEventId({
      headerPresent: false,
      queryKeyPresent: true,
      query: '',
    });
    assert.equal(r.ok, false);
  });

  it('rejects non-integer and negative', () => {
    assert.equal(
      parseLastEventId({ headerPresent: true, header: '-1' }).ok,
      false
    );
    assert.equal(
      parseLastEventId({ headerPresent: true, header: '1.5' }).ok,
      false
    );
    assert.equal(
      parseLastEventId({ headerPresent: true, header: 'abc' }).ok,
      false
    );
  });

  it('parses oversized safe-integer without Number coercion', () => {
    const big = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    const r = parseLastEventId({ headerPresent: true, header: big });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, BigInt(big));
  });

  it('rejects values above Postgres BIGINT max', () => {
    const tooBig = '9223372036854775808';
    const r = parseLastEventId({ headerPresent: true, header: tooBig });
    assert.equal(r.ok, false);
  });
});
