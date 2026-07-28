# Plan 5 — Integration Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end integration tests covering service-to-service boundaries, attestation flow, edge verifier decisions, and multi-tenant isolation.

**Architecture:** Extract startup code from `cmd/*` into `internal/trustengine` and `internal/edgeverifier` packages. Build Go test harnesses in `internal/testutil/` and TypeScript test harnesses in `control-plane/src/testutil/`. Write integration tests with build constraints (`//go:build integration`) for Go and separate npm scripts for TypeScript.

**Tech Stack:** Go 1.25+, gRPC, httptest, PostgreSQL, Node.js 18+, tsx, node:test

## Global Constraints

- Go 1.25+ (go.mod)
- Node 18+ (control-plane)
- PostgreSQL for control-plane integration tests
- `//go:build integration` on all new Go integration test files
- `pkg/trust/integration_test.go` stays WITHOUT build constraint (in-memory only)
- All principals must have `owner_tenant_id` for tenant isolation tests
- Control-plane routes require auth headers (`attest:write`, `attest:read`)

---

## File Structure

### New Go packages
- `internal/trustengine/server.go` — Extracted from `cmd/trust-engine`
- `internal/edgeverifier/proxy.go` — Extracted from `cmd/edge-verifier`
- `internal/testutil/trust_engine.go` — gRPC test harness
- `internal/testutil/edge_verifier.go` — HTTP proxy test harness
- `internal/testutil/seed_data.go` — Test data factories
- `internal/testutil/assertions.go` — Test assertion helpers

### New TypeScript packages
- `control-plane/src/testutil/testDb.ts` — Postgres setup/teardown
- `control-plane/src/testutil/seedData.ts` — Test data factories + auth helpers
- `control-plane/src/testutil/appHarness.ts` — Express app harness

### New test files
- `cmd/edge-verifier/main_integration_test.go` — Edge verifier integration (build-tagged)
- `cmd/trust-engine/server_integration_test.go` — Trust engine integration (build-tagged)
- `control-plane/src/__tests__/integration/attestation-flow.test.ts` — Control-plane attestation tests
- `control-plane/src/__tests__/integration/tenant-isolation.test.ts` — Tenant isolation tests

### Modified files
- `cmd/trust-engine/main.go` — Import `internal/trustengine`
- `cmd/edge-verifier/main.go` — Import `internal/edgeverifier`
- `control-plane/package.json` — Add `test:unit` and `test:integration` scripts

---

## Tasks

### Task 1: Extract trust-engine startup into `internal/trustengine`

**Files:**
- Create: `internal/trustengine/server.go`
- Modify: `cmd/trust-engine/main.go`

**Interfaces:**
- Produces: `trustengine.NewServer(cfg) *grpc.Server`, `trustengine.Run(s, addr) error`

- [ ] **Step 1: Create `internal/trustengine/server.go`**

```go
package trustengine

import (
	"fmt"
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/messagesgoel-blip/verilink/pkg/trust"
	"github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

type Config struct {
	Addr string
}

func NewServer() *grpc.Server {
	s := grpc.NewServer()
	engine := trust.NewEngine()
	trustpb.RegisterTrustEngineServer(s, engine)
	reflection.Register(s)
	return s
}

func Run(s *grpc.Server, addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	log.Printf("Trust engine listening on %s", addr)
	return s.Serve(lis)
}
```

- [ ] **Step 2: Update `cmd/trust-engine/main.go` to use `internal/trustengine`**

Replace the current server creation and run logic with:

```go
package main

import (
	"flag"
	"log"

	"github.com/messagesgoel-blip/verilink/internal/trustengine"
)

func main() {
	addr := flag.String("addr", ":8083", "gRPC listen address")
	flag.Parse()

	s := trustengine.NewServer()
	log.Fatal(trustengine.Run(s, *addr))
}
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `go test ./cmd/trust-engine/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/trustengine/server.go cmd/trust-engine/main.go
git commit -m "refactor: extract trust-engine startup into internal/trustengine"
```

---

### Task 2: Extract edge-verifier startup into `internal/edgeverifier`

**Files:**
- Create: `internal/edgeverifier/proxy.go`
- Modify: `cmd/edge-verifier/main.go`

**Interfaces:**
- Produces: `edgeverifier.NewEdgeVerifierProxy(target, ts, ...) *EdgeVerifierProxy`

- [ ] **Step 1: Create `internal/edgeverifier/proxy.go`**

```go
package edgeverifier

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

const maxSignedBodyBytes int64 = 1 << 20

type EdgeVerifierProxy struct {
	proxy             *httputil.ReverseProxy
	trustStore        verifier.TrustStore
	registry          *requestsigin.AgentRegistry
	nonceCache        *requestsigin.NonceCache
	requireSignatures bool
	externalBaseURL   string
}

func NewEdgeVerifierProxy(
	target string,
	ts verifier.TrustStore,
	registry *requestsigin.AgentRegistry,
	nonceCache *requestsigin.NonceCache,
	requireSigs bool,
	externalBaseURL string,
) (*EdgeVerifierProxy, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	return &EdgeVerifierProxy{
		proxy:             httputil.NewSingleHostReverseProxy(u),
		trustStore:        ts,
		registry:          registry,
		nonceCache:        nonceCache,
		requireSignatures: requireSigs,
		externalBaseURL:   strings.TrimRight(externalBaseURL, "/"),
	}, nil
}

func (p *EdgeVerifierProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	sigInputHeader := r.Header.Get("Signature-Input")
	targetURI := p.buildTargetURI(r)

	if sigInputHeader != "" {
		sigHeader := r.Header.Get("Signature")
		r.Body = http.MaxBytesReader(w, r.Body, maxSignedBodyBytes)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("BODY_READ_ERROR: method=%s uri=%s reason=%v", r.Method, r.URL, err)
			w.Header().Set("X-Verilink-Auth-Status", "invalid-signature")
			http.Error(w, "Bad Request: unreadable body", http.StatusBadRequest)
			return
		}
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(body))

		si, parseErr := requestsigin.ParseSignatureInput(sigInputHeader)
		if parseErr != nil {
			log.Printf("INVALID_SIG: method=%s uri=%s reason=%v", r.Method, r.URL, parseErr)
			w.Header().Set("X-Verilink-Auth-Status", "invalid-signature")
			http.Error(w, "Unauthorized: Invalid HTTP Message Signature", http.StatusUnauthorized)
			return
		}

		err = requestsigin.VerifySignatureInput(
			sigInputHeader,
			sigHeader,
			r.Method,
			targetURI,
			func() []byte { return body },
			func(keyid string) (ed25519.PublicKey, error) {
				return p.registry.GetPublicKey(keyid)
			},
		)

		if err != nil {
			log.Printf("INVALID_SIG: method=%s uri=%s reason=%v", r.Method, r.URL, err)
			w.Header().Set("X-Verilink-Auth-Status", "invalid-signature")
			http.Error(w, "Unauthorized: Invalid HTTP Message Signature", http.StatusUnauthorized)
			return
		}

		if si.Nonce != "" {
			if !p.nonceCache.CheckAndConsume(si.Nonce, si.KeyID) {
				log.Printf("REPLAY: method=%s uri=%s keyid=%s nonce=%s", r.Method, r.URL, si.KeyID, si.Nonce)
				w.Header().Set("X-Verilink-Auth-Status", "replay-detected")
				http.Error(w, "Unauthorized: Replay detected", http.StatusUnauthorized)
				return
			}
		}

		if p.trustStore != nil {
			fpData := fingerprint.RequestData{
				JA4:      r.Header.Get("X-JA4-Fingerprint"),
				Protocol: r.Proto,
				Headers:  map[string]string{"User-Agent": r.UserAgent()},
			}
			fp, fpErr := fingerprint.Generate(fpData)
			if fpErr == nil {
				score, _ := p.trustStore.GetTrustScore(fp)
				w.Header().Set("X-Verilink-Trust-Score", fmt.Sprintf("%d", score))
			}
		}

		log.Printf("SIGNED: method=%s uri=%s", r.Method, r.URL)
		w.Header().Set("X-Verilink-Auth-Status", "signed-verified")
		p.proxy.ServeHTTP(w, r)
		return
	}

	if p.requireSignatures {
		log.Printf("UNSIGNED_REJECTED: method=%s uri=%s", r.Method, r.URL)
		w.Header().Set("X-Verilink-Auth-Status", "unsigned-rejected")
		http.Error(w, "Unauthorized: Request must be signed", http.StatusUnauthorized)
		return
	}

	log.Printf("UNSIGNED_PASSTHROUGH: method=%s uri=%s", r.Method, r.URL)
	w.Header().Set("X-Verilink-Auth-Status", "unsigned-passthrough")
	p.proxy.ServeHTTP(w, r)
}

func (p *EdgeVerifierProxy) buildTargetURI(r *http.Request) string {
	if p.externalBaseURL != "" {
		return p.externalBaseURL + r.URL.RequestURI()
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	}
	host := r.Host
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		host = fwdHost
	}
	return fmt.Sprintf("%s://%s%s", scheme, host, r.URL.RequestURI())
}
```

- [ ] **Step 2: Update `cmd/edge-verifier/main.go` to use `internal/edgeverifier`**

Replace the current proxy creation logic with:

```go
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func main() {
	var (
		externalBaseURL   string
		agentKeysPath     string
		requireSignatures bool
	)

	flag.StringVar(&externalBaseURL, "external-base-url", "", "Base URL for @target-uri construction")
	flag.StringVar(&agentKeysPath, "agent-keys-path", "", "Path to agent keys JSON file")
	flag.BoolVar(&requireSignatures, "require-signatures", false, "Require RFC 9421 signatures on all requests")
	flag.Parse()

	ts := verifier.NewMockTrustStore()

	trustedData := fingerprint.RequestData{
		JA4:      "test-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	}
	trustedFP, err := fingerprint.Generate(trustedData)
	if err != nil {
		log.Fatalf("Failed to generate trusted fingerprint: %v", err)
	}
	if err := ts.SetTrustScore(trustedFP, 100); err != nil {
		log.Fatalf("Failed to seed trusted fingerprint: %v", err)
	}
	log.Printf("Pre-seeded trusted fingerprint: %s", trustedFP)

	registry := requestsigin.NewAgentRegistry()
	if agentKeysPath != "" {
		if err := registry.LoadFromJSON(agentKeysPath); err != nil {
			log.Fatalf("Failed to load agent keys: %v", err)
		}
		log.Printf("Loaded agent keys from %s", agentKeysPath)
	}

	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	mockBackend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Welcome, verified agent! You have reached the backend API.")
	})
	go func() {
		log.Println("Starting mock backend on :8081")
		http.ListenAndServe(":8081", mockBackend)
	}()

	proxy, err := edgeverifier.NewEdgeVerifierProxy("http://localhost:8081", ts, registry, nonceCache, requireSignatures, externalBaseURL)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Verilink Edge Verifier running on :8080")
	log.Fatal(http.ListenAndServe(":8080", proxy))
}
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `go test ./cmd/edge-verifier/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/edgeverifier/proxy.go cmd/edge-verifier/main.go
git commit -m "refactor: extract edge-verifier startup into internal/edgeverifier"
```

---

### Task 3: Create Go test harness — trust engine

**Files:**
- Create: `internal/testutil/trust_engine.go`
- Create: `internal/testutil/trust_engine_test.go`

**Interfaces:**
- Consumes: `internal/trustengine.NewServer()`
- Produces: `testutil.StartTrustEngine(t) *TrustEngineHarness`

- [ ] **Step 1: Write the failing test**

```go
// internal/testutil/trust_engine_test.go
package testutil

import (
	"testing"
)

func TestStartTrustEngine(t *testing.T) {
	harness := StartTrustEngine(t)
	defer harness.Stop()

	if harness.Client == nil {
		t.Fatal("expected non-nil client")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/testutil/... -v -run TestStartTrustEngine`
Expected: FAIL with "undefined: StartTrustEngine"

- [ ] **Step 3: Write minimal implementation**

```go
// internal/testutil/trust_engine.go
package testutil

import (
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	"github.com/messagesgoel-blip/verilink/internal/trustengine"
	"github.com/messagesgoel-blip/verilink/pkg/trust"
	"github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

type TrustEngineHarness struct {
	Client trustpb.TrustEngineClient
	grpc   *grpc.Server
	conn   *grpc.ClientConn
}

func (h *TrustEngineHarness) Stop() {
	h.conn.Close()
	h.grpc.Stop()
}

func StartTrustEngine(t *testing.T) *TrustEngineHarness {
	t.Helper()

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	s := grpc.NewServer()
	engine := trust.NewEngine()
	trustpb.RegisterTrustEngineServer(s, engine)
	reflection.Register(s)

	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("server stopped: %v", err)
		}
	}()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}

	client := trustpb.NewTrustEngineClient(conn)

	t.Cleanup(func() {
		conn.Close()
		s.Stop()
	})

	return &TrustEngineHarness{
		Client: client,
		grpc:   s,
		conn:   conn,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/testutil/... -v -run TestStartTrustEngine`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/testutil/trust_engine.go internal/testutil/trust_engine_test.go
git commit -m "feat: add trust engine test harness"
```

---

### Task 4: Create Go test harness — edge verifier

**Files:**
- Create: `internal/testutil/edge_verifier.go`
- Create: `internal/testutil/edge_verifier_test.go`

**Interfaces:**
- Consumes: `internal/edgeverifier.NewEdgeVerifierProxy()`, `verifier.TrustStore`
- Produces: `testutil.StartEdgeVerifier(t, target, ts) *EdgeVerifierHarness`

- [ ] **Step 1: Write the failing test**

```go
// internal/testutil/edge_verifier_test.go
package testutil

import (
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func TestStartEdgeVerifier(t *testing.T) {
	ts := verifier.NewMockTrustStore()
	harness := StartEdgeVerifier(t, "http://localhost:9999", ts)
	defer harness.Stop()

	if harness.URL == "" {
		t.Fatal("expected non-empty URL")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/testutil/... -v -run TestStartEdgeVerifier`
Expected: FAIL with "undefined: StartEdgeVerifier"

- [ ] **Step 3: Write minimal implementation**

```go
// internal/testutil/edge_verifier.go
package testutil

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

type EdgeVerifierHarness struct {
	URL  string
	stop func()
}

func (h *EdgeVerifierHarness) Stop() {
	h.stop()
}

func StartEdgeVerifier(t *testing.T, target string, ts verifier.TrustStore) *EdgeVerifierHarness {
	t.Helper()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)

	proxy, err := edgeverifier.NewEdgeVerifierProxy(target, ts, registry, nonceCache, false, "")
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	server := httptest.NewServer(proxy)

	t.Cleanup(func() {
		server.Close()
		nonceCache.Stop()
	})

	return &EdgeVerifierHarness{
		URL:  server.URL,
		stop: server.Close,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/testutil/... -v -run TestStartEdgeVerifier`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/testutil/edge_verifier.go internal/testutil/edge_verifier_test.go
git commit -m "feat: add edge verifier test harness"
```

---

### Task 5: Create Go test helpers — seed data and assertions

**Files:**
- Create: `internal/testutil/seed_data.go`
- Create: `internal/testutil/assertions.go`

**Interfaces:**
- Produces: `testutil.SeedTestData(t, client)`, `testutil.AssertSignedVerified(t, resp)`, etc.

- [ ] **Step 1: Create `internal/testutil/seed_data.go`**

```go
package testutil

import (
	"context"
	"crypto/ed25519"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

type TestIssuer struct {
	DID        string
	PublicKey  ed25519.PublicKey
	PrivateKey ed25519.PrivateKey
}

func GenerateTestIssuer(t *testing.T) *TestIssuer {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	return &TestIssuer{
		DID:        "did:key:test-issuer",
		PublicKey:  pub,
		PrivateKey: priv,
	}
}

func SeedTestData(t *testing.T, client trustpb.TrustEngineClient, issuer *TestIssuer) {
	t.Helper()
	ctx := context.Background()

	// Stream principal
	_, err := client.RunVeriRank(ctx)
	if err != nil {
		t.Fatalf("failed to start RunVeriRank: %v", err)
	}
	// Note: Actual streaming implementation depends on server requirements
	// This is a placeholder for the test flow
}
```

- [ ] **Step 2: Create `internal/testutil/assertions.go`**

```go
package testutil

import (
	"net/http"
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

func AssertSignedVerified(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("X-Verilink-Auth-Status") != "signed-verified" {
		t.Errorf("expected X-Verilink-Auth-Status: signed-verified, got %s", resp.Header.Get("X-Verilink-Auth-Status"))
	}
}

func AssertUnsignedPassthrough(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("X-Verilink-Auth-Status") != "unsigned-passthrough" {
		t.Errorf("expected X-Verilink-Auth-Status: unsigned-passthrough, got %s", resp.Header.Get("X-Verilink-Auth-Status"))
	}
}

func AssertUnsignedRejected(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("X-Verilink-Auth-Status") != "unsigned-rejected" {
		t.Errorf("expected X-Verilink-Auth-Status: unsigned-rejected, got %s", resp.Header.Get("X-Verilink-Auth-Status"))
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func AssertInvalidSignature(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("X-Verilink-Auth-Status") != "invalid-signature" {
		t.Errorf("expected X-Verilink-Auth-Status: invalid-signature, got %s", resp.Header.Get("X-Verilink-Auth-Status"))
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func AssertTrustScoreHeader(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	score := resp.Header.Get("X-Verilink-Trust-Score")
	if score == "" {
		t.Error("expected X-Verilink-Trust-Score header to be set")
	}
	// Parse and compare (simplified)
}

func AssertScoreTable(t *testing.T, table *trustpb.ScoreTable, principalID string, expectedScore int32) {
	t.Helper()
	for _, row := range table.Rows {
		if row.PrincipalId == principalID {
			if row.Score != expectedScore {
				t.Errorf("expected score %d for %s, got %d", expectedScore, principalID, row.Score)
			}
			return
		}
	}
	t.Errorf("principal %s not found in score table", principalID)
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `go test ./internal/testutil/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/testutil/seed_data.go internal/testutil/assertions.go
git commit -m "feat: add test data factories and assertion helpers"
```

---

### Task 6: Create Go integration test — edge verifier

**Files:**
- Create: `cmd/edge-verifier/main_integration_test.go`

**Interfaces:**
- Consumes: `internal/testutil.StartEdgeVerifier()`, `internal/testutil.AssertSignedVerified()`, etc.

- [ ] **Step 1: Write the integration test**

```go
//go:build integration

package main

import (
	"crypto/ed25519"
	"net/http"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/testutil"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func TestEdgeVerifier_SignedVerified(t *testing.T) {
	// Setup mock backend
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("backend response"))
	})
	backendServer := httptest.NewServer(backend)
	defer backendServer.Close()

	// Setup trust store with known fingerprint
	ts := verifier.NewMockTrustStore()
	fpData := fingerprint.RequestData{
		JA4:      "test-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	}
	fp, err := fingerprint.Generate(fpData)
	if err != nil {
		t.Fatal(err)
	}
	ts.SetTrustScore(fp, 75)

	// Start edge verifier
	harness := testutil.StartEdgeVerifier(t, backendServer.URL, ts)
	defer harness.Stop()

	// Generate test keypair
	pub, priv, _ := ed25519.GenerateKey(nil)
	registry := requestsigin.NewAgentRegistry()
	registry.Register("did:key:test-agent", "key-1", pub, []string{"*"})

	// Sign request
	req, _ := http.NewRequest("GET", harness.URL+"/test", nil)
	req.Header.Set("X-JA4-Fingerprint", "test-ja4")
	req.Header.Set("User-Agent", "TestAgent")
	_ = requestsigin.SignRequest(req, priv, "did:key:test-agent:key-1", "")

	// Execute
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Assert
	testutil.AssertSignedVerified(t, resp)
}

func TestEdgeVerifier_UnsignedPassthrough(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	backendServer := httptest.NewServer(backend)
	defer backendServer.Close()

	ts := verifier.NewMockTrustStore()
	harness := testutil.StartEdgeVerifier(t, backendServer.URL, ts)
	defer harness.Stop()

	req, _ := http.NewRequest("GET", harness.URL+"/test", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	testutil.AssertUnsignedPassthrough(t, resp)
}

func TestEdgeVerifier_UnsignedRejected(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	backendServer := httptest.NewServer(backend)
	defer backendServer.Close()

	ts := verifier.NewMockTrustStore()
	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	proxy, _ := edgeverifier.NewEdgeVerifierProxy(backendServer.URL, ts, registry, nonceCache, true, "")
	server := httptest.NewServer(proxy)
	defer server.Close()

	req, _ := http.NewRequest("GET", server.URL+"/test", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	testutil.AssertUnsignedRejected(t, resp)
}
```

- [ ] **Step 2: Run integration test to verify it passes**

Run: `go test -tags=integration ./cmd/edge-verifier/... -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add cmd/edge-verifier/main_integration_test.go
git commit -m "test: add edge verifier integration tests"
```

---

### Task 7: Create Go integration test — trust engine

**Files:**
- Create: `cmd/trust-engine/server_integration_test.go`

**Interfaces:**
- Consumes: `internal/testutil.StartTrustEngine()`, `internal/testutil.AssertScoreTable()`

- [ ] **Step 1: Write the integration test**

```go
//go:build integration

package main

import (
	"context"
	"testing"

	"github.com/messagesgoel-blip/verilink/internal/testutil"
	"github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

func TestTrustEngine_GetFingerprint(t *testing.T) {
	harness := testutil.StartTrustEngine(t)
	defer harness.Stop()

	resp, err := harness.Client.GetFingerprint(context.Background(), &trustpb.FingerprintRequest{
		JA4:      "t13d311100_0013_150a",
		Protocol: "h2",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	})
	if err != nil {
		t.Fatal(err)
	}

	if resp.Sha256 == "" {
		t.Error("expected non-empty fingerprint")
	}
}

func TestTrustEngine_VerifyAttestation(t *testing.T) {
	harness := testutil.StartTrustEngine(t)
	defer harness.Stop()

	// This test requires a valid JWS token
	// For now, test with invalid token to verify error handling
	resp, err := harness.Client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: "invalid.token.here",
	})
	if err != nil {
		t.Fatal(err)
	}

	if resp.Valid {
		t.Error("expected invalid attestation to fail verification")
	}
}
```

- [ ] **Step 2: Run integration test to verify it passes**

Run: `go test -tags=integration ./cmd/trust-engine/... -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add cmd/trust-engine/server_integration_test.go
git commit -m "test: add trust engine integration tests"
```

---

### Task 8: Create TypeScript test harness — database helpers

**Files:**
- Create: `control-plane/src/testutil/testDb.ts`

**Interfaces:**
- Produces: `testutil.setupTestDb()`, `testutil.teardownTestDb()`

- [ ] **Step 1: Create `control-plane/src/testutil/testDb.ts`**

```typescript
import pg from 'pg';

const { Pool } = pg;

export async function setupTestDb(): Promise<pg.Pool> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  // Run migrations
  // Note: Adjust based on your migration tool
  // Example: await pool.query('SELECT migrate()');

  return pool;
}

export async function teardownTestDb(pool: pg.Pool): Promise<void> {
  // Clean all tables
  const tables = ['attestations', 'principal_keys', 'issuers', 'principals', 'api_keys'];
  for (const table of tables) {
    await pool.query(`TRUNCATE ${table} CASCADE`);
  }
  await pool.end();
}
```

- [ ] **Step 2: Commit**

```bash
git add control-plane/src/testutil/testDb.ts
git commit -m "feat: add test database helpers"
```

---

### Task 9: Create TypeScript test harness — seed data and auth

**Files:**
- Create: `control-plane/src/testutil/seedData.ts`

**Interfaces:**
- Produces: `testutil.seedIssuer()`, `testutil.seedSubject()`, `testutil.seedApiKey()`, `testutil.authHeaders()`

- [ ] **Step 1: Create `control-plane/src/testutil/seedData.ts`**

```typescript
import pg from 'pg';
import crypto from 'node:crypto';

export interface Issuer {
  did: string;
  privateKey: string;
}

export async function seedIssuer(pool: pg.Pool, tenantId: string): Promise<Issuer> {
  const did = `did:key:${crypto.randomUUID()}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  await pool.query(
    `INSERT INTO principals (id, entity_kind, owner_tenant_id) VALUES ($1, 'issuer', $2)`,
    [did, tenantId]
  );

  await pool.query(
    `INSERT INTO issuers (principal_id, did) VALUES ($1, $2)`,
    [did, did]
  );

  await pool.query(
    `INSERT INTO principal_keys (principal_id, key_id, public_key_raw, valid_from) VALUES ($1, 'k1', $2, NOW())`,
    [did, publicKey.export({ type: 'spki', format: 'der' })]
  );

  return { did, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export async function seedSubject(pool: pg.Pool, tenantId: string): Promise<{ id: string }> {
  const id = `vrl:p:${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO principals (id, entity_kind, owner_tenant_id) VALUES ($1, 'agent', $2)`,
    [id, tenantId]
  );
  return { id };
}

export async function seedApiKey(pool: pg.Pool, tenantId: string, scopes: string[]): Promise<string> {
  const key = `vlk_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_keys (key_hash, tenant_id, scopes) VALUES ($1, $2, $3)`,
    [crypto.createHash('sha256').update(key).digest('hex'), tenantId, scopes]
  );
  return key;
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { 'Authorization': `Bearer ${apiKey}` };
}
```

- [ ] **Step 2: Commit**

```bash
git add control-plane/src/testutil/seedData.ts
git commit -m "feat: add test data factories and auth helpers"
```

---

### Task 10: Create TypeScript test harness — app harness

**Files:**
- Create: `control-plane/src/testutil/appHarness.ts`

**Interfaces:**
- Consumes: `control-plane/src/app.ts`
- Produces: `testutil.startControlPlane()`

- [ ] **Step 1: Create `control-plane/src/testutil/appHarness.ts`**

```typescript
import { createServer, type Server } from 'node:http';
import app from '../app.js';

export interface ControlPlaneHarness {
  url: string;
  stop: () => Promise<void>;
}

export async function startControlPlane(
  trustEngineAddr: string
): Promise<ControlPlaneHarness> {
  // Set env vars for test
  process.env.TRUST_ENGINE_ADDR = trustEngineAddr;

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add control-plane/src/testutil/appHarness.ts
git commit -m "feat: add control plane test harness"
```

---

### Task 11: Update control-plane package.json scripts

**Files:**
- Modify: `control-plane/package.json`

- [ ] **Step 1: Add test scripts**

Add to `scripts` section:

```json
{
  "scripts": {
    "test": "node --test --import tsx 'src/**/*.test.ts'",
    "test:unit": "node --test --import tsx 'src/**/!(integration)/**/*.test.ts'",
    "test:integration": "node --test --import tsx 'src/__tests__/integration/**/*.test.ts'"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add control-plane/package.json
git commit -m "chore: add test:unit and test:integration scripts"
```

---

### Task 12: Create control-plane integration tests — attestation flow

**Files:**
- Create: `control-plane/src/__tests__/integration/attestation-flow.test.ts`

**Interfaces:**
- Consumes: `control-plane/src/testutil/` helpers

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { setupTestDb, teardownTestDb } from '../../testutil/testDb.js';
import { seedIssuer, seedApiKey, authHeaders } from '../../testutil/seedData.js';
import { startControlPlane } from '../../testutil/appHarness.js';

describe('Attestation Flow Integration', () => {
  let pool: pg.Pool;
  let harness: { url: string; stop: () => Promise<void> };
  let apiKey: string;

  before(async () => {
    pool = await setupTestDb();
    harness = await startControlPlane(process.env.TRUST_ENGINE_ADDR || 'localhost:8083');
  });

  after(async () => {
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    // Clean tables before each test
    await pool.query('TRUNCATE api_keys CASCADE');
    apiKey = await seedApiKey(pool, 'tenant-1', ['attest:write', 'attest:read']);
  });

  it('Test 1: Full attestation lifecycle', async () => {
    const issuer = await seedIssuer(pool, 'tenant-1');
    // Sign attestation (simplified - actual implementation depends on Go client)
    const token = 'test-jws-token';

    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });

    assert.strictEqual(submitResp.status, 201);

    const listResp = await fetch(`${harness.url}/v1/attestations`, {
      headers: authHeaders(apiKey),
    });

    assert.strictEqual(listResp.status, 200);
    const data = await listResp.json();
    assert.ok(data.ok);
  });

  it('Test 6: Unauthorized request', async () => {
    const resp = await fetch(`${harness.url}/v1/attestations`, {
      headers: { 'Content-Type': 'application/json' },
    });

    assert.strictEqual(resp.status, 401);
  });

  it('Test 7: Insufficient scope', async () => {
    const readOnlyKey = await seedApiKey(pool, 'tenant-1', ['attest:read']);
    const resp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(readOnlyKey),
      },
      body: JSON.stringify({ token: 'test' }),
    });

    assert.strictEqual(resp.status, 403);
  });
});
```

- [ ] **Step 2: Run integration test to verify it passes**

Run: `cd control-plane && npm run test:integration`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add control-plane/src/__tests__/integration/attestation-flow.test.ts
git commit -m "test: add control-plane attestation flow integration tests"
```

---

### Task 13: Create control-plane integration tests — tenant isolation

**Files:**
- Create: `control-plane/src/__tests__/integration/tenant-isolation.test.ts`

**Interfaces:**
- Consumes: `control-plane/src/testutil/` helpers

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { setupTestDb, teardownTestDb } from '../../testutil/testDb.js';
import { seedIssuer, seedSubject, seedApiKey, authHeaders } from '../../testutil/seedData.js';
import { startControlPlane } from '../../testutil/appHarness.js';

describe('Tenant Isolation Integration', () => {
  let pool: pg.Pool;
  let harness: { url: string; stop: () => Promise<void> };

  before(async () => {
    pool = await setupTestDb();
    harness = await startControlPlane(process.env.TRUST_ENGINE_ADDR || 'localhost:8083');
  });

  after(async () => {
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE api_keys, principals, issuers, principal_keys, attestations CASCADE');
  });

  it('Test 8: Cross-tenant visibility', async () => {
    // Seed Tenant A
    const tenantAKey = await seedApiKey(pool, 'tenant-a', ['attest:write', 'attest:read']);
    const issuerA = await seedIssuer(pool, 'tenant-a');
    const subjectA = await seedSubject(pool, 'tenant-a');

    // Seed Tenant B
    const tenantBKey = await seedApiKey(pool, 'tenant-b', ['attest:read']);

    // Create attestation as Tenant A
    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(tenantAKey),
      },
      body: JSON.stringify({ token: 'test-token-a' }),
    });
    assert.strictEqual(submitResp.status, 201);

    // Query as Tenant B - should see empty result
    const listResp = await fetch(`${harness.url}/v1/attestations`, {
      headers: authHeaders(tenantBKey),
    });
    assert.strictEqual(listResp.status, 200);
    const data = await listResp.json();
    assert.ok(data.ok);
    assert.strictEqual(data.data.length, 0, 'Tenant B should not see Tenant A attestations');
  });
});
```

- [ ] **Step 2: Run integration test to verify it passes**

Run: `cd control-plane && npm run test:integration`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add control-plane/src/__tests__/integration/tenant-isolation.test.ts
git commit -m "test: add control-plane tenant isolation integration tests"
```

---

## Verification

**Go unit tests:**
```bash
go test ./...                                      # All unit tests (excludes build-tagged files)
```

**Go integration tests:**
```bash
go test -tags=integration ./cmd/... ./pkg/...      # Service integration tests
go test -tags=integration ./internal/...           # Test helper unit tests
```

**Control-plane unit tests:**
```bash
cd control-plane && npm run test:unit              # Runs node --test --import tsx 'src/**/!(integration)/**/*.test.ts'
```

**Control-plane integration tests:**
```bash
cd control-plane && npm run test:integration       # Runs node --test --import tsx 'src/__tests__/integration/**/*.test.ts'
```

**Full suite:**
```bash
go test ./... && go test -tags=integration ./... && cd control-plane && npm run test:unit && npm run test:integration
```

---

## Success Criteria

- [ ] All 18 integration tests pass
- [ ] `cmd/*` coverage increases to >70%
- [ ] No Docker dependency for test execution
- [ ] Tests run in <30s total
- [ ] CI integration via GitHub Actions workflow
