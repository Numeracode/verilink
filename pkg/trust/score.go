package trust

// ScoreReason is the machine-readable reason for a score.
// Valid values: "propagated", "blacklisted".
// "expired" is NOT an engine value — the control plane handles expiration by
// deleting the row + emitting score.delete. "unknown" is not stored (no row).
// "verified" is removed (redundant with "propagated").
type ScoreReason string

const (
	ScoreReasonPropagated  ScoreReason = "propagated"
	ScoreReasonBlacklisted ScoreReason = "blacklisted"
)

// EntityKind classifies a principal in the trust graph.
type EntityKind string

const (
	EntityKindAgent  EntityKind = "agent"
	EntityKindIssuer EntityKind = "issuer"
	EntityKindBoth   EntityKind = "both"
)

// Root is a weighted bootstrap root of trust. The engine initializes a root
// at 100 * weight. Default weight = 1.0 (score 100). Stepwise de-emphasis
// reduces weight; issuers.trust_weight is the orthogonal issuer-quality knob
// and is NOT touched by de-emphasis.
type Root struct {
	ID     string
	Weight float64
}

// Issuer is a principal that can sign attestations, with a trust_weight that
// multiplies its contributions in VeriRank. trust_weight is the orthogonal
// issuer-quality knob; bootstrap de-emphasis uses Root.Weight, not trust_weight.
type Issuer struct {
	DID         string  // the principal ID (vrl:p:<uuid>)
	TrustWeight float64 // 0.0..1.0 multiplier on this issuer's contributions
	IsBootstrap bool
}

// Principal is a trust-graph entity (agent, issuer, or both). The control plane
// streams these to the engine so it can stamp entity_kind on output rows.
type Principal struct {
	ID          string     // vrl:p:<uuid>
	EntityKind  EntityKind // agent | issuer | both
	TrustWeight float64    // 0.0..1.0; default 1.0 if the principal is absent from the stream
	IsBootstrap bool
}

// ScoreRow is one row of VeriRank output, keyed by canonical principal ID.
type ScoreRow struct {
	PrincipalID string
	EntityKind  EntityKind
	Score       int
	Blacklisted bool
	ScoreReason ScoreReason
}

// ScoreTable is the full VeriRank output. Rows are sorted by PrincipalID for
// deterministic serialization.
type ScoreTable struct {
	Rows           []ScoreRow
	ComputedAtUnix int64
}