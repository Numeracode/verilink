package edgeverifier

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
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
	snapshot          *Store
	syncReachable     atomic.Bool
	wal               *DecisionWAL
	metrics           *Metrics
}

// NewEdgeVerifierProxy creates the proxy (demo / test path without sync snapshot).
func NewEdgeVerifierProxy(target string, ts verifier.TrustStore, registry *requestsigin.AgentRegistry, nonceCache *requestsigin.NonceCache, requireSigs bool, externalBaseURL string) (*EdgeVerifierProxy, error) {
	return NewEdgeVerifierProxyWithSnapshot(target, ts, registry, nonceCache, requireSigs, externalBaseURL, nil)
}

// NewEdgeVerifierProxyWithSnapshot creates the proxy. When snapshot is non-nil,
// keys and principal scores come from the synced store (Plan 8).
func NewEdgeVerifierProxyWithSnapshot(target string, ts verifier.TrustStore, registry *requestsigin.AgentRegistry, nonceCache *requestsigin.NonceCache, requireSigs bool, externalBaseURL string, snapshot *Store) (*EdgeVerifierProxy, error) {
	return NewEdgeVerifierProxyFull(target, ts, registry, nonceCache, requireSigs, externalBaseURL, snapshot, nil, nil)
}

// NewEdgeVerifierProxyFull creates the proxy with optional WAL + metrics.
func NewEdgeVerifierProxyFull(
	target string,
	ts verifier.TrustStore,
	registry *requestsigin.AgentRegistry,
	nonceCache *requestsigin.NonceCache,
	requireSigs bool,
	externalBaseURL string,
	snapshot *Store,
	wal *DecisionWAL,
	metrics *Metrics,
) (*EdgeVerifierProxy, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}

	p := &EdgeVerifierProxy{
		proxy:             httputil.NewSingleHostReverseProxy(u),
		trustStore:        ts,
		registry:          registry,
		nonceCache:        nonceCache,
		requireSignatures: requireSigs,
		externalBaseURL:   strings.TrimRight(externalBaseURL, "/"),
		snapshot:          snapshot,
		wal:               wal,
		metrics:           metrics,
	}
	p.syncReachable.Store(true)
	return p, nil
}

// SetSyncReachable updates whether the SSE loop considers control plane reachable.
func (p *EdgeVerifierProxy) SetSyncReachable(ok bool) {
	p.syncReachable.Store(ok)
}

// ServeHTTP implements the three-way outcome model.
func (p *EdgeVerifierProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if p.metrics != nil {
		p.metrics.ObserveStore(p.snapshot)
	}
	if mode := EvaluateMode(p.snapshot, p.syncReachable.Load(), time.Now()); mode != ModeOK {
		w.Header().Set("X-Verilink-Mode", string(mode))
		if mode == ModeStale {
			http.Error(w, "Service Unavailable: sync snapshot stale", http.StatusServiceUnavailable)
			return
		}
	}

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
			p.recordDecision(r, Decision{Action: "deny", ScoreReason: "invalid-signature"})
			http.Error(w, "Unauthorized: Invalid HTTP Message Signature", http.StatusUnauthorized)
			return
		}

		err = requestsigin.VerifySignatureInput(
			sigInputHeader,
			sigHeader,
			r.Method,
			targetURI,
			func() []byte { return body },
			p.lookupPublicKey,
		)

		if err != nil {
			log.Printf("INVALID_SIG: method=%s uri=%s reason=%v", r.Method, r.URL, err)
			w.Header().Set("X-Verilink-Auth-Status", "invalid-signature")
			p.recordDecision(r, Decision{Action: "deny", ScoreReason: "invalid-signature"})
			http.Error(w, "Unauthorized: Invalid HTTP Message Signature", http.StatusUnauthorized)
			return
		}

		if si.Nonce != "" {
			if !p.nonceCache.CheckAndConsume(si.Nonce, si.KeyID) {
				log.Printf("REPLAY: method=%s uri=%s keyid=%s nonce=%s", r.Method, r.URL, si.KeyID, si.Nonce)
				w.Header().Set("X-Verilink-Auth-Status", "replay-detected")
				p.recordDecision(r, Decision{Action: "deny", ScoreReason: "replay-detected"})
				http.Error(w, "Unauthorized: Replay detected", http.StatusUnauthorized)
				return
			}
		}

		denied, reason, principalID, score, blacklisted := p.annotateTrust(w, r, si.KeyID)
		if denied {
			log.Printf("DENIED: method=%s uri=%s reason=%s", r.Method, r.URL, reason)
			w.Header().Set("X-Verilink-Auth-Status", "denied")
			if reason != "" {
				w.Header().Set("X-Verilink-Reason", reason)
			}
			p.recordDecision(r, Decision{
				PrincipalID: principalID,
				Score:       score,
				Blacklisted: blacklisted,
				ScoreReason: reason,
				Action:      "deny",
			})
			http.Error(w, "Forbidden: trust policy denied", http.StatusForbidden)
			return
		}

		log.Printf("SIGNED: method=%s uri=%s", r.Method, r.URL)
		w.Header().Set("X-Verilink-Auth-Status", "signed-verified")
		p.recordDecision(r, Decision{
			PrincipalID: principalID,
			Score:       score,
			Blacklisted: blacklisted,
			ScoreReason: reason,
			Action:      "allow",
		})
		p.proxy.ServeHTTP(w, r)
		return
	}

	requireSig := RequireSignaturesFromPolicy(p.snapshot, p.requireSignatures)
	if requireSig {
		log.Printf("UNSIGNED_REJECTED: method=%s uri=%s", r.Method, r.URL)
		w.Header().Set("X-Verilink-Auth-Status", "unsigned-rejected")
		p.recordDecision(r, Decision{Action: "deny", ScoreReason: "unsigned-rejected"})
		http.Error(w, "Unauthorized: Request must be signed", http.StatusUnauthorized)
		return
	}

	log.Printf("UNSIGNED_PASSTHROUGH: method=%s uri=%s", r.Method, r.URL)
	w.Header().Set("X-Verilink-Auth-Status", "unsigned-passthrough")
	p.recordDecision(r, Decision{Action: "passthrough", ScoreReason: "unsigned"})
	p.proxy.ServeHTTP(w, r)
}

func (p *EdgeVerifierProxy) lookupPublicKey(keyid string) (ed25519.PublicKey, error) {
	if p.snapshot != nil && p.snapshot.Load() != nil {
		return p.snapshot.PublicKey(keyid, time.Now())
	}
	return p.registry.GetPublicKey(keyid)
}

func (p *EdgeVerifierProxy) annotateTrust(w http.ResponseWriter, r *http.Request, keyID string) (denied bool, reason, principalID string, score int, blacklisted bool) {
	if p.snapshot != nil && p.snapshot.Load() != nil {
		key, ok := p.snapshot.LookupKey(keyID, time.Now())
		if !ok {
			return true, "unknown-key", "", 0, false
		}
		principalID = key.PrincipalID
		allow, score, scoreReason := AllowByScore(p.snapshot, key.PrincipalID)
		entry, _ := p.snapshot.LookupScore(key.PrincipalID)
		blacklisted = entry.Blacklisted
		w.Header().Set("X-Verilink-Trust-Score", fmt.Sprintf("%d", score))
		w.Header().Set("X-Verilink-Principal", key.PrincipalID)
		if scoreReason != "" {
			w.Header().Set("X-Verilink-Score-Reason", scoreReason)
		}
		if !allow {
			return true, scoreReason, principalID, score, blacklisted
		}
		return false, scoreReason, principalID, score, blacklisted
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
	return false, "", "", 0, false
}

func (p *EdgeVerifierProxy) recordDecision(r *http.Request, d Decision) {
	if p == nil || p.wal == nil {
		return
	}
	if d.Fingerprint == "" {
		d.Fingerprint = requestFingerprint(r)
	}
	if d.DecidedAt.IsZero() {
		d.DecidedAt = time.Now().UTC()
	}
	// Policy can enable no-drop; local CLI/env override stays sticky inside DecisionWAL.
	if p.snapshot != nil {
		if active := p.snapshot.ActivePolicy(); active != nil {
			p.wal.SetNoDrop(active.NoDropDecisions)
		}
	}
	if err := p.wal.Append(d); err != nil {
		if errors.Is(err, ErrWALFull) {
			log.Printf("WAL_FULL: action=%s fingerprint=%s", d.Action, d.Fingerprint)
			return
		}
		log.Printf("WAL_APPEND: %v", err)
	}
}

func requestFingerprint(r *http.Request) string {
	if r == nil {
		return ""
	}
	fpData := fingerprint.RequestData{
		JA4:      r.Header.Get("X-JA4-Fingerprint"),
		Protocol: r.Proto,
		Headers:  map[string]string{"User-Agent": r.UserAgent()},
	}
	fp, err := fingerprint.Generate(fpData)
	if err != nil {
		return ""
	}
	return fp
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
