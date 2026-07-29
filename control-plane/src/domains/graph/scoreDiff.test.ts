import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreChanged } from './scoreDiff.js';

describe('scoreChanged', () => {
  const base = {
    principal_id: 'p1',
    entity_kind: 'agent',
    score: 50,
    blacklisted: false,
    score_reason: 'propagated',
  };

  it('detects score / blacklisted / score_reason / entity_kind changes', () => {
    assert.equal(scoreChanged(base, { ...base }), false);
    assert.equal(scoreChanged(base, { ...base, score: 51 }), true);
    assert.equal(scoreChanged(base, { ...base, blacklisted: true }), true);
    assert.equal(scoreChanged(base, { ...base, score_reason: 'blacklisted' }), true);
    assert.equal(scoreChanged(base, { ...base, entity_kind: 'both' }), true);
  });
});
