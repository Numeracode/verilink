-- control-plane/migrations/002_attestations/migration.sql

-- Attestations: signed behavioral reports (global)
CREATE TABLE attestations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id       TEXT NOT NULL REFERENCES issuers(principal_id),
  subject_id      TEXT NOT NULL REFERENCES principals(id),
  jws_token       TEXT NOT NULL,
  token_digest    TEXT NOT NULL UNIQUE,             -- sha256(jws_token); dedup
  payload         JSONB NOT NULL,
  facts           JSONB NOT NULL,                   -- shareable facts (public or participants)
  facts_hash      TEXT NOT NULL,                    -- sha256(RFC 8785 JCS(facts)); exact-content identity
  visibility      TEXT NOT NULL DEFAULT 'participants' CHECK (visibility IN ('participants', 'public')),
  trust_delta     INTEGER NOT NULL CHECK (trust_delta BETWEEN -100 AND 100),
  attestation_type TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  jti             TEXT,
  observation_id  TEXT,                             -- for split-visibility pairing; null = no pairing
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,
  superseded_by   UUID REFERENCES attestations(id),
  sig_verified    BOOLEAN NOT NULL DEFAULT true,
  verified_key_id TEXT NOT NULL,                    -- which key verified (from VerifyResult)
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (attestation_type = 'negative_incident' AND trust_delta < 0)
    OR (attestation_type <> 'negative_incident' AND trust_delta >= 0)
  ),
  -- Composite FK: the verified key belongs to the issuer
  FOREIGN KEY (issuer_id, verified_key_id) REFERENCES principal_keys(principal_id, key_id)
);

CREATE INDEX idx_attestations_subject ON attestations (subject_id);
CREATE INDEX idx_attestations_issuer ON attestations (issuer_id);
CREATE INDEX idx_attestations_issued_at ON attestations (issued_at);

-- Network scores: materialized VeriRank output (global)
CREATE TABLE network_scores (
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  entity_kind     TEXT NOT NULL,
  score           INTEGER NOT NULL,
  blacklisted     BOOLEAN NOT NULL DEFAULT false,
  score_reason    TEXT NOT NULL CHECK (score_reason IN ('propagated', 'blacklisted')),
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_version    BIGINT NOT NULL,
  PRIMARY KEY (principal_id)
);

-- Score history: one row per principal per score CHANGE
CREATE TABLE network_score_history (
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL,
  blacklisted     BOOLEAN NOT NULL,
  score_reason    TEXT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL,
  sync_version    BIGINT NOT NULL,
  PRIMARY KEY (principal_id, sync_version)
);
