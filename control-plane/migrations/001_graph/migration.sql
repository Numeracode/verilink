-- control-plane/migrations/001_graph/migration.sql

-- Unified principals: agents and issuers share one namespace.
CREATE TABLE principals (
  id              TEXT PRIMARY KEY,                  -- vrl:p:<uuid>
  entity_kind     TEXT NOT NULL CHECK (entity_kind IN ('agent', 'issuer', 'both')),
  name            TEXT,
  owner_tenant_id UUID,                             -- FK added in 004_tenancy
  metadata        JSONB DEFAULT '{}',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  deactivated_at  TIMESTAMPTZ
);

-- assurance_level is DERIVED from principal_keys (has a non-revoked key with
-- control_verified_at set → verified_key; else unknown). Not a stored column.

-- Principal keys (rotation/history)
CREATE TABLE principal_keys (
  principal_id    TEXT NOT NULL REFERENCES principals(id),
  key_id          TEXT NOT NULL,                     -- e.g. k1
  public_key_raw  BYTEA NOT NULL,                   -- raw 32-byte Ed25519 public key
  public_key_jwk  JSONB NOT NULL,                   -- did:key verification method form
  key_hash        TEXT NOT NULL,                    -- sha256(public_key_raw); indexed for lookup
  control_verified_at TIMESTAMPTZ,                  -- set when the principal proved control of this key
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,                      -- null = current
  revoked_at      TIMESTAMPTZ,
  revocation_reason TEXT,
  PRIMARY KEY (principal_id, key_id)
);

-- A public key is globally unique by key_hash: one key belongs to at most
-- one principal, even across rotation/validity windows.
CREATE UNIQUE INDEX key_hash_unique ON principal_keys (key_hash);

-- Issuer attributes (a principal that can sign attestations)
CREATE TABLE issuers (
  principal_id    TEXT PRIMARY KEY REFERENCES principals(id),
  trust_weight    NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (trust_weight >= 0), -- issuer-quality knob; NOT touched by bootstrap de-emphasis
  is_bootstrap    BOOLEAN DEFAULT false,            -- derived from bootstrap_issuers by the seeder
  verified_at     TIMESTAMPTZ,                      -- set after proof of key control + review
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
