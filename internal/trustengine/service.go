package trustengine

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/trust"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type server struct {
	trustpb.UnimplementedTrustEngineServer
}

// RunVeriRank consumes a client-streamed RunChunk sequence and returns a ScoreTable.
// The first chunk MUST be a RunHeader; subsequent chunks are attestations,
// principals, and roots in any order.
func (s *server) RunVeriRank(stream trustpb.TrustEngine_RunVeriRankServer) error {
	var (
		evalTime       time.Time
		claims         []*attestation.AttestationClaims
		principals     []trust.Principal
		roots          []trust.Root
		headerSeen     bool
		seenPrincipals = make(map[string]bool)
		seenRoots      = make(map[string]bool)
	)

	for {
		chunk, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return status.Errorf(codes.Internal, "recv chunk: %v", err)
		}
		if chunk == nil || chunk.Payload == nil {
			return status.Error(codes.InvalidArgument, "nil chunk payload")
		}

		switch p := chunk.Payload.(type) {
		case *trustpb.RunChunk_Header:
			if headerSeen {
				return status.Error(codes.InvalidArgument, "duplicate RunHeader")
			}
			if p.Header == nil {
				return status.Error(codes.InvalidArgument, "nil RunHeader")
			}
			if p.Header.EvaluationTimeUnix == 0 {
				return status.Error(codes.InvalidArgument, "evaluation_time_unix is required")
			}
			evalTime = time.Unix(p.Header.EvaluationTimeUnix, 0)
			headerSeen = true
		case *trustpb.RunChunk_Attestation:
			if !headerSeen {
				return status.Error(codes.InvalidArgument, "header must be first chunk")
			}
			if p.Attestation == nil {
				return status.Error(codes.InvalidArgument, "nil Attestation")
			}
			if p.Attestation.IssuerId == "" || p.Attestation.SubjectId == "" {
				return status.Error(codes.InvalidArgument, "attestation issuer_id and subject_id are required")
			}
			if p.Attestation.IssuedAtUnix == 0 {
				return status.Error(codes.InvalidArgument, "attestation issued_at_unix is required")
			}
			if p.Attestation.TrustDelta < math.MinInt32 || p.Attestation.TrustDelta > math.MaxInt32 {
				return status.Errorf(codes.InvalidArgument, "attestation trust_delta %d out of int32 range", p.Attestation.TrustDelta)
			}
			claims = append(claims, protoAttestationToClaims(p.Attestation))
		case *trustpb.RunChunk_Principal:
			if !headerSeen {
				return status.Error(codes.InvalidArgument, "header must be first chunk")
			}
			if p.Principal == nil {
				return status.Error(codes.InvalidArgument, "nil Principal")
			}
			if p.Principal.Id == "" {
				return status.Error(codes.InvalidArgument, "principal id is required")
			}
			if seenPrincipals[p.Principal.Id] {
				return status.Errorf(codes.InvalidArgument, "duplicate principal %s", p.Principal.Id)
			}
			seenPrincipals[p.Principal.Id] = true
			ek := trust.EntityKind(p.Principal.EntityKind)
			switch ek {
			case trust.EntityKindAgent, trust.EntityKindIssuer, trust.EntityKindBoth:
			default:
				return status.Errorf(codes.InvalidArgument, "principal %s invalid entity_kind %q", p.Principal.Id, p.Principal.EntityKind)
			}
			tw := p.Principal.TrustWeight
			if math.IsNaN(tw) || tw < 0 || tw > 1 {
				return status.Errorf(codes.InvalidArgument, "principal %s trust_weight %f is non-finite or out of range [0,1]", p.Principal.Id, tw)
			}
			principals = append(principals, trust.Principal{
				ID:          p.Principal.Id,
				EntityKind:  ek,
				TrustWeight: tw,
				IsBootstrap: p.Principal.IsBootstrap,
			})
		case *trustpb.RunChunk_Root:
			if !headerSeen {
				return status.Error(codes.InvalidArgument, "header must be first chunk")
			}
			if p.Root == nil {
				return status.Error(codes.InvalidArgument, "nil Root")
			}
			if p.Root.Id == "" {
				return status.Error(codes.InvalidArgument, "root id is required")
			}
			if seenRoots[p.Root.Id] {
				return status.Errorf(codes.InvalidArgument, "duplicate root %s", p.Root.Id)
			}
			seenRoots[p.Root.Id] = true
			w := p.Root.Weight
			if math.IsNaN(w) || w < 0 || w > 1 {
				return status.Errorf(codes.InvalidArgument, "root %s weight %f is non-finite or out of range [0,1]", p.Root.Id, w)
			}
			roots = append(roots, trust.Root{
				ID:     p.Root.Id,
				Weight: w,
			})
		default:
			return status.Error(codes.InvalidArgument, "unknown or empty chunk payload")
		}
	}

	if !headerSeen {
		return status.Error(codes.InvalidArgument, "missing RunHeader chunk")
	}

	// Validate completeness: every root, every attestation issuer, and every
	// attestation subject must have a streamed Principal row.
	principalSet := make(map[string]bool, len(principals))
	kindByID := make(map[string]trust.EntityKind, len(principals))
	for _, p := range principals {
		principalSet[p.ID] = true
		kindByID[p.ID] = p.EntityKind
	}
	for _, r := range roots {
		if !principalSet[r.ID] {
			return status.Errorf(codes.InvalidArgument, "root %s has no streamed Principal row", r.ID)
		}
	}
	for _, c := range claims {
		if !principalSet[c.Issuer] {
			return status.Errorf(codes.InvalidArgument, "attestation issuer %s has no streamed Principal row", c.Issuer)
		}
		// Issuers must have entity_kind "issuer" or "both" — agent-only
		// principals cannot issue attestations.
		if ek := kindByID[c.Issuer]; ek != trust.EntityKindIssuer && ek != trust.EntityKindBoth {
			return status.Errorf(codes.InvalidArgument, "attestation issuer %s has entity_kind %q (must be issuer or both)", c.Issuer, string(ek))
		}
		if !principalSet[c.Subject] {
			return status.Errorf(codes.InvalidArgument, "attestation subject %s has no streamed Principal row", c.Subject)
		}
	}
	// Roots must be bootstrap principals with trust_weight = 1.0.
	for _, r := range roots {
		var found *trust.Principal
		for i := range principals {
			if principals[i].ID == r.ID {
				found = &principals[i]
				break
			}
		}
		if found == nil {
			continue
		}
		if !found.IsBootstrap {
			return status.Errorf(codes.InvalidArgument, "root %s is not a bootstrap principal", r.ID)
		}
		if found.TrustWeight != 1.0 {
			return status.Errorf(codes.InvalidArgument, "root %s (bootstrap) must have trust_weight=1.0, got %f", r.ID, found.TrustWeight)
		}
	}

	engine := trust.NewEngine()
	table := engine.RunVeriRank(claims, principals, roots, evalTime)

	// Stamp entity_kind from the streamed principals.
	kindMap := make(map[string]string, len(principals))
	for _, p := range principals {
		kindMap[p.ID] = string(p.EntityKind)
	}

	pbRows := make([]*trustpb.ScoreRow, 0, len(table.Rows))
	for _, row := range table.Rows {
		ek := string(row.EntityKind)
		if ek == "" {
			ek = kindMap[row.PrincipalID]
		}
		pbRows = append(pbRows, &trustpb.ScoreRow{
			PrincipalId: row.PrincipalID,
			EntityKind:  ek,
			Score:       int32(row.Score),
			Blacklisted: row.Blacklisted,
			ScoreReason: string(row.ScoreReason),
		})
	}

	sort.Slice(pbRows, func(i, j int) bool {
		return pbRows[i].PrincipalId < pbRows[j].PrincipalId
	})

	return stream.SendAndClose(&trustpb.ScoreTable{
		Rows:           pbRows,
		ComputedAtUnix: table.ComputedAtUnix,
	})
}

func protoAttestationToClaims(a *trustpb.Attestation) *attestation.AttestationClaims {
	issuedAt := time.Unix(a.IssuedAtUnix, 0)
	var expiresAt *jwt.NumericDate
	if a.ExpiresAtUnix > 0 {
		expiresAt = jwt.NewNumericDate(time.Unix(a.ExpiresAtUnix, 0))
	}
	return &attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    a.IssuerId,
			Subject:   a.SubjectId,
			IssuedAt:  jwt.NewNumericDate(issuedAt),
			ExpiresAt: expiresAt,
		},
		VerilinkClaims: attestation.VerilinkClaims{
			Type:            a.AttestationType,
			TrustLevelDelta: int(a.TrustDelta),
			ObservationID:   a.ObservationId,
		},
	}
}

// VerifyAttestation tries each candidate key against the JWS token.
// Returns the verified_key_id that matched, plus all signed vli fields.
func (s *server) VerifyAttestation(ctx context.Context, req *trustpb.VerifyRequest) (*trustpb.VerifyResult, error) {
	if req.JwsToken == "" {
		return &trustpb.VerifyResult{Valid: false, Error: "jws_token is required"}, nil
	}
	if len(req.CandidateKeys) == 0 {
		return &trustpb.VerifyResult{Valid: false, Error: "at least one candidate key is required"}, nil
	}

	for _, cand := range req.CandidateKeys {
		if len(cand.PublicKey) != ed25519.PublicKeySize {
			continue
		}
		pub := ed25519.PublicKey(cand.PublicKey)
		claims, err := attestation.Verify(req.JwsToken, pub)
		if err != nil {
			continue
		}

		if claims.Issuer == "" || claims.Subject == "" || claims.IssuedAt == nil {
			return &trustpb.VerifyResult{
				Valid: false,
				Error: "verified token missing required iss/sub/iat",
			}, nil
		}

		factsJSON, err := json.Marshal(claims.VerilinkClaims.Facts)
		if err != nil {
			return &trustpb.VerifyResult{
				Valid: false,
				Error: fmt.Sprintf("marshal facts: %v", err),
			}, nil
		}

		var expUnix int64
		if claims.ExpiresAt != nil {
			expUnix = claims.ExpiresAt.Time.Unix()
		}

		jti := ""
		if claims.ID != "" {
			jti = claims.ID
		}

		return &trustpb.VerifyResult{
			Valid:         true,
			VerifiedKeyId: cand.KeyId,
			IssuerId:      claims.Issuer,
			SubjectId:     claims.Subject,
			Payload: &trustpb.AttestationPayload{
				AttestationType: claims.VerilinkClaims.Type,
				FactsJson:       factsJSON,
				TrustLevelDelta: int32(claims.VerilinkClaims.TrustLevelDelta),
				IssuedAtUnix:    claims.IssuedAt.Time.Unix(),
				ExpiresAtUnix:   expUnix,
				Jti:             jti,
				SchemaVersion:   claims.VerilinkClaims.SchemaVersion,
				Visibility:      claims.VerilinkClaims.Visibility,
				ObservationId:   claims.VerilinkClaims.ObservationID,
			},
		}, nil
	}

	return &trustpb.VerifyResult{
		Valid: false,
		Error: "no candidate key verified the token",
	}, nil
}

// GetFingerprint matches pkg/fingerprint.Generate exactly.
func (s *server) GetFingerprint(ctx context.Context, req *trustpb.FingerprintRequest) (*trustpb.Fingerprint, error) {
	fp, err := fingerprint.Generate(fingerprint.RequestData{
		JA4:      req.Ja4,
		Headers:  req.Headers,
		KeyHash:  req.KeyHash,
		Protocol: req.Protocol,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "fingerprint: %v", err)
	}
	return &trustpb.Fingerprint{Sha256: fp}, nil
}
