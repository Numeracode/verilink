import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupAttestationsForScoring } from './observationGrouping.js';

function att(partial: {
  id: string;
  observation_id?: string | null;
  visibility?: string;
  issued_at?: Date;
  issuer_id?: string;
  subject_id?: string;
}) {
  return {
    id: partial.id,
    issuer_id: partial.issuer_id ?? 'issuer-a',
    subject_id: partial.subject_id ?? 'subject-b',
    observation_id: partial.observation_id ?? null,
    visibility: partial.visibility ?? 'public',
    issued_at: partial.issued_at ?? new Date('2026-01-02T00:00:00Z'),
    trust_delta: 10,
    attestation_type: 'behavioral',
    expires_at: null,
  };
}

describe('groupAttestationsForScoring', () => {
  it('never collapses unpaired attestations', () => {
    const rows = [att({ id: '1' }), att({ id: '2' })];
    const out = groupAttestationsForScoring(rows);
    assert.equal(out.length, 2);
  });

  it('collapses same observation_id preferring participants', () => {
    const rows = [
      att({
        id: 'pub',
        observation_id: 'obs-1',
        visibility: 'public',
        issued_at: new Date('2026-01-03T00:00:00Z'),
      }),
      att({
        id: 'part',
        observation_id: 'obs-1',
        visibility: 'participants',
        issued_at: new Date('2026-01-01T00:00:00Z'),
      }),
    ];
    const out = groupAttestationsForScoring(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'part');
  });

  it('uses newest issued_at when visibility ties', () => {
    const rows = [
      att({
        id: 'old',
        observation_id: 'obs-1',
        visibility: 'public',
        issued_at: new Date('2026-01-01T00:00:00Z'),
      }),
      att({
        id: 'new',
        observation_id: 'obs-1',
        visibility: 'public',
        issued_at: new Date('2026-01-05T00:00:00Z'),
      }),
    ];
    const out = groupAttestationsForScoring(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'new');
  });

  it('does not merge different observation ids', () => {
    const rows = [
      att({ id: 'a', observation_id: 'obs-1' }),
      att({ id: 'b', observation_id: 'obs-2' }),
    ];
    assert.equal(groupAttestationsForScoring(rows).length, 2);
  });
});
