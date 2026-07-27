package main

import (
	"bytes"
	"crypto/ed25519"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

const maxSignedBodyBytes int64 = 1 << 20 // 1 MiB

// EdgeVerifierProxy is the main proxy with RFC 9421 signature verification.
type EdgeVerifierProxy struct {
	proxy             *httputil.ReverseProxy
	trustStore        verifier.TrustStore
	registry          *requestsigin.AgentRegistry
	nonceCache        *requestsigin.NonceCache
	requireSignatures bool
	externalBaseURL   string
}

// NewEdgeVerifierProxy creates the proxy.
func NewEdgeVerifierProxy(target string, ts verifier.TrustStore, registry *requestsigin.AgentRegistry, nonceCache *requestsigin.NonceCache, requireSigs bool, externalBaseURL string) (*EdgeVerifierProxy, error) {
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

// ServeHTTP implements the three-way outcome model.
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

		// Parse the signature input to get keyid and nonce for nonce cache
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

		// Nonce replay check
		if si.Nonce != "" {
			if !p.nonceCache.CheckAndConsume(si.Nonce, si.KeyID) {
				log.Printf("REPLAY: method=%s uri=%s keyid=%s nonce=%s", r.Method, r.URL, si.KeyID, si.Nonce)
				w.Header().Set("X-Verilink-Auth-Status", "replay-detected")
				http.Error(w, "Unauthorized: Replay detected", http.StatusUnauthorized)
				return
			}
		}

		// Consult trust store for signed requests and propagate score
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

	// Unsigned request: policy-based passthrough or rejection
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

// buildTargetURI reconstructs the full target URI for the request.
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

func main() {
	var (
		externalBaseURL   string
		agentKeysPath     string
		requireSignatures bool
	)

	flag.StringVar(&externalBaseURL, "external-base-url", "", "Base URL for @target-uri construction (mandatory behind a TLS-terminating proxy)")
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

	proxy, err := NewEdgeVerifierProxy("http://localhost:8081", ts, registry, nonceCache, requireSignatures, externalBaseURL)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Verilink Edge Verifier running on :8080")
	log.Fatal(http.ListenAndServe(":8080", proxy))
}
