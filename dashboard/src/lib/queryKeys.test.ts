import { describe, it, expect } from 'vitest';
import { providerQueryKeys } from './queryKeys';

describe('providerQueryKeys', () => {
  it('embeds the tenant id in every key', () => {
    const keys = providerQueryKeys('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    for (const key of Object.values(keys)) {
      expect(key[key.length - 1]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    }
  });

  it('partitions cache across tenants', () => {
    const a = providerQueryKeys('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const b = providerQueryKeys('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(a.aggregates).not.toEqual(b.aggregates);
    expect(a.graphSummary).not.toEqual(b.graphSummary);
  });

  it('falls back to a stable sentinel for no tenant', () => {
    const keys = providerQueryKeys(null);
    expect(keys.aggregates[keys.aggregates.length - 1]).toBe('none');
  });
});


import { agentBuilderQueryKeys } from './queryKeys';

describe('agentBuilderQueryKeys', () => {
  it('partitions by tenant and selected principal', () => {
    const a = agentBuilderQueryKeys('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'vrl:p:1');
    const b = agentBuilderQueryKeys('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'vrl:p:1');
    const other = agentBuilderQueryKeys('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'vrl:p:2');
    expect(a.detail).not.toEqual(b.detail);
    expect(a.detail).not.toEqual(other.detail);
  });

  it('falls back to a sentinel for null tenant/principal', () => {
    const keys = agentBuilderQueryKeys(null, null);
    expect(keys.detail[keys.detail.length - 1]).toBe('none');
  });
});