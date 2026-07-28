package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"math"
	"net"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// startTestServer starts a gRPC server on a random port using newGRPCServer
// (same interceptors + registration as production) and returns a client +
// the raw connection (for health checks) + a cleanup func.
func startTestServer(t *testing.T) (trustpb.TrustEngineClient, *grpc.ClientConn, func()) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	grpcSrv, _ := newGRPCServer()
	go grpcSrv.Serve(lis)

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	client := trustpb.NewTrustEngineClient(conn)
	return client, conn, func() {
		conn.Close()
		grpcSrv.GracefulStop()
	}
}

func TestServer_RunVeriRank_3Hop(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	now := time.Now()
	stream, err := client.RunVeriRank(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Header first
	if err := stream.Send(&trustpb.RunChunk{
		Payload: &trustpb.RunChunk_Header{
			Header: &trustpb.RunHeader{EvaluationTimeUnix: now.Unix()},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Principals (all 4 entities must be streamed)
	principals := []struct {
		id, kind  string
		weight    float64
		bootstrap bool
	}{
		{"vrl:p:root", "issuer", 1.0, true},
		{"vrl:p:a", "both", 1.0, false},
		{"vrl:p:b", "both", 1.0, false},
		{"vrl:p:c", "agent", 1.0, false},
	}
	for _, p := range principals {
		if err := stream.Send(&trustpb.RunChunk{
			Payload: &trustpb.RunChunk_Principal{
				Principal: &trustpb.Principal{
					Id: p.id, EntityKind: p.kind, TrustWeight: p.weight, IsBootstrap: p.bootstrap,
				},
			},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Root
	if err := stream.Send(&trustpb.RunChunk{
		Payload: &trustpb.RunChunk_Root{
			Root: &trustpb.Root{Id: "vrl:p:root", Weight: 1.0},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Attestations: root -> A -> B -> C
	atts := []struct{ issuer, subject string }{
		{"vrl:p:root", "vrl:p:a"},
		{"vrl:p:a", "vrl:p:b"},
		{"vrl:p:b", "vrl:p:c"},
	}
	for _, a := range atts {
		if err := stream.Send(&trustpb.RunChunk{
			Payload: &trustpb.RunChunk_Attestation{
				Attestation: &trustpb.Attestation{
					IssuerId:        a.issuer,
					SubjectId:       a.subject,
					TrustDelta:      100,
					IssuedAtUnix:    now.Unix(),
					AttestationType: "transaction_summary",
				},
			},
		}); err != nil {
			t.Fatal(err)
		}
	}

	table, err := stream.CloseAndRecv()
	if err != nil {
		t.Fatal(err)
	}

	// C must score non-zero (3-hop transitive propagation)
	var cScore int32
	var cKind string
	for _, row := range table.Rows {
		if row.PrincipalId == "vrl:p:c" {
			cScore = row.Score
			cKind = row.EntityKind
		}
	}
	if cScore <= 0 {
		t.Fatalf("3-hop via gRPC FAILED: C scored %d (expected >0)", cScore)
	}
	if cKind != "agent" {
		t.Errorf("expected C entity_kind=agent, got %s", cKind)
	}
	t.Logf("3-hop gRPC OK: C scored %d kind=%s", cScore, cKind)
}

func TestServer_RunVeriRank_MissingPrincipalRejected(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	now := time.Now()
	stream, err := client.RunVeriRank(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Header{
		Header: &trustpb.RunHeader{EvaluationTimeUnix: now.Unix()},
	}})
	// Send root but NO principal for it — should be rejected.
	stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Root{
		Root: &trustpb.Root{Id: "vrl:p:root", Weight: 1.0},
	}})
	stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Attestation{
		Attestation: &trustpb.Attestation{
			IssuerId: "vrl:p:root", SubjectId: "vrl:p:a",
			TrustDelta: 100, IssuedAtUnix: now.Unix(), AttestationType: "transaction_summary",
		},
	}})

	_, err = stream.CloseAndRecv()
	if err == nil {
		t.Fatal("expected error for missing principal metadata, got nil")
	}
}

func TestServer_RunVeriRank_DuplicateHeader(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	now := time.Now()
	stream, err := client.RunVeriRank(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Header{
		Header: &trustpb.RunHeader{EvaluationTimeUnix: now.Unix()},
	}})
	if err := stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Header{
		Header: &trustpb.RunHeader{EvaluationTimeUnix: now.Unix()},
	}}); err == nil {
		// Some gRPC impls buffer; the error surfaces on CloseAndRecv.
	}
	_, err = stream.CloseAndRecv()
	if err == nil {
		t.Fatal("expected error for duplicate header, got nil")
	}
}

func TestServer_RunVeriRank_NaNWeight(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	now := time.Now()
	stream, _ := client.RunVeriRank(context.Background())
	stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Header{
		Header: &trustpb.RunHeader{EvaluationTimeUnix: now.Unix()},
	}})
	stream.Send(&trustpb.RunChunk{Payload: &trustpb.RunChunk_Principal{
		Principal: &trustpb.Principal{
			Id: "vrl:p:x", EntityKind: "agent",
			TrustWeight: math.NaN(),
		},
	}})
	_, err := stream.CloseAndRecv()
	if err == nil {
		t.Fatal("expected error for NaN weight, got nil")
	}
}

func TestServer_VerifyAttestation(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	issuer := "vrl:p:issuer"
	subject := "vrl:p:subject"
	token, err := attestation.Sign(issuer, subject, attestation.VerilinkClaims{
		Type:            "transaction_summary",
		Facts:           map[string]interface{}{"count": 42},
		TrustLevelDelta: 50,
		SchemaVersion:   "1",
		Visibility:      "participants",
		ObservationID:   "obs-123",
	}, priv)
	if err != nil {
		t.Fatal(err)
	}

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: token,
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "k1", PublicKey: pub},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Valid {
		t.Fatalf("expected valid, got invalid: %s", res.Error)
	}
	if res.VerifiedKeyId != "k1" {
		t.Errorf("expected verified_key_id k1, got %s", res.VerifiedKeyId)
	}
	if res.IssuerId != issuer {
		t.Errorf("expected issuer %s, got %s", issuer, res.IssuerId)
	}
	if res.Payload.SchemaVersion != "1" {
		t.Errorf("expected schema_version 1, got %s", res.Payload.SchemaVersion)
	}
	if res.Payload.Visibility != "participants" {
		t.Errorf("expected visibility participants, got %s", res.Payload.Visibility)
	}
	if res.Payload.ObservationId != "obs-123" {
		t.Errorf("expected observation_id obs-123, got %s", res.Payload.ObservationId)
	}
	var facts map[string]interface{}
	if err := json.Unmarshal(res.Payload.FactsJson, &facts); err != nil {
		t.Fatalf("unmarshal facts_json: %v", err)
	}
	if facts["count"] != float64(42) {
		t.Errorf("expected facts.count=42, got %v", facts["count"])
	}
}

func TestServer_VerifyAttestation_PanicRecovery(t *testing.T) {
	info := &grpc.UnaryServerInfo{FullMethod: "/test/Panic"}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		panic("deliberate panic")
	}

	resp, err := unaryPanicRecovery(context.Background(), nil, info, handler)
	if err == nil {
		t.Fatal("expected error from panic recovery, got nil")
	}
	if status.Code(err) != codes.Internal {
		t.Errorf("expected codes.Internal, got %s", status.Code(err))
	}
	if resp != nil {
		t.Errorf("expected nil response, got %v", resp)
	}

	streamInfo := &grpc.StreamServerInfo{FullMethod: "/test/PanicStream"}
	streamHandler := func(srv interface{}, ss grpc.ServerStream) error {
		panic("deliberate stream panic")
	}
	err = streamPanicRecovery(nil, nil, streamInfo, streamHandler)
	if err == nil {
		t.Fatal("expected error from stream panic recovery, got nil")
	}
	if status.Code(err) != codes.Internal {
		t.Errorf("expected codes.Internal, got %s", status.Code(err))
	}
}

func TestServer_VerifyAttestation_JtiRoundTrip(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	issuer := "vrl:p:issuer"
	subject := "vrl:p:subject"

	claims := &attestation.AttestationClaims{
		VerilinkClaims: attestation.VerilinkClaims{
			Type:            "transaction_summary",
			Facts:           map[string]interface{}{"count": 1},
			TrustLevelDelta: 10,
		},
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   subject,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(365 * 24 * time.Hour)),
			ID:        "jti-test-abc123",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	signedToken, err := token.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: signedToken,
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "k1", PublicKey: pub},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Valid {
		t.Fatalf("expected valid, got invalid: %s", res.Error)
	}
	if res.Payload.Jti != "jti-test-abc123" {
		t.Errorf("expected jti jti-test-abc123, got %s", res.Payload.Jti)
	}
}

func TestServer_VerifyAttestation_WrongKeyFirst(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	wrongPub, _, _ := ed25519.GenerateKey(rand.Reader)
	rightPub, rightPriv, _ := ed25519.GenerateKey(rand.Reader)

	token, err := attestation.Sign("vrl:p:issuer", "vrl:p:subject", attestation.VerilinkClaims{
		Type:            "transaction_summary",
		TrustLevelDelta: 50,
	}, rightPriv)
	if err != nil {
		t.Fatal(err)
	}

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: token,
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "wrong", PublicKey: wrongPub},
			{KeyId: "right", PublicKey: rightPub},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Valid {
		t.Fatal("expected valid with second key")
	}
	if res.VerifiedKeyId != "right" {
		t.Errorf("expected verified_key_id right, got %s", res.VerifiedKeyId)
	}
}

func TestServer_VerifyAttestation_MalformedKey(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: "some.token.here",
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "k1", PublicKey: []byte("too-short")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Valid {
		t.Error("expected invalid for malformed key")
	}
}

func TestServer_GetFingerprint(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	res, err := client.GetFingerprint(context.Background(), &trustpb.FingerprintRequest{
		Ja4:      "test-ja4",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
		Protocol: "HTTP/1.1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Sha256 == "" {
		t.Fatal("expected non-empty fingerprint")
	}
}
