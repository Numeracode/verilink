package testutil

import (
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

// EdgeVerifierHarness wraps a live EdgeVerifierProxy HTTP server for tests.
type EdgeVerifierHarness struct {
	URL        string
	Registry   *requestsigin.AgentRegistry
	NonceCache *requestsigin.NonceCache
	server     *httptest.Server
	once       sync.Once
}

// Stop closes the httptest server and nonce cache.
func (h *EdgeVerifierHarness) Stop() {
	h.once.Do(func() {
		if h.server != nil {
			h.server.Close()
		}
		if h.NonceCache != nil {
			h.NonceCache.Stop()
		}
	})
}

// StartEdgeVerifier starts an EdgeVerifierProxy against target with the given
// trust store. Signatures are not required by default (permissive mode).
func StartEdgeVerifier(t *testing.T, target string, ts verifier.TrustStore) *EdgeVerifierHarness {
	t.Helper()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)

	proxy, err := edgeverifier.NewEdgeVerifierProxy(target, ts, registry, nonceCache, false, "")
	if err != nil {
		nonceCache.Stop()
		t.Fatalf("failed to create proxy: %v", err)
	}

	server := httptest.NewServer(proxy)
	h := &EdgeVerifierHarness{
		URL:        server.URL,
		Registry:   registry,
		NonceCache: nonceCache,
		server:     server,
	}
	t.Cleanup(h.Stop)
	return h
}
