package trust

import (
	"log"
	"sync"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

// TrustWriter defines the interface for updating the edge cache.
type TrustWriter interface {
	SetTrustScore(fingerprint string, score verifier.TrustScore) error
	DeleteTrustScore(fingerprint string) error
	ListTrustFingerprints() ([]string, error)
}

// SyncService orchestrates the background calculation and propagation of trust scores.
type SyncService struct {
	mu            sync.Mutex
	attestService *attestation.Service
	trustEngine   *Engine
	edgeCache     TrustWriter
	syncInterval  time.Duration
	stopChan      chan struct{}
	stopOnce      sync.Once
	startOnce     sync.Once
}

// NewSyncService creates a new trust synchronization service.
func NewSyncService(as *attestation.Service, te *Engine, ec TrustWriter, interval time.Duration) *SyncService {
	// Guard against non-positive interval
	if interval <= 0 {
		log.Printf("WARNING: Non-positive sync interval provided (%v). Defaulting to 1 hour.", interval)
		interval = time.Hour
	}

	return &SyncService{
		attestService: as,
		trustEngine:   te,
		edgeCache:     ec,
		syncInterval:  interval,
		stopChan:      make(chan struct{}),
	}
}

// Start runs the sync loop in a background goroutine. It is idempotent.
func (s *SyncService) Start() {
	s.startOnce.Do(func() {
		// Prime the cache by running sync once before starting the background loop
		log.Println("Priming trust cache with initial sync...")
		s.RunSync()

		ticker := time.NewTicker(s.syncInterval)
		log.Printf("Trust Sync Service started (Interval: %v)", s.syncInterval)

		go func() {
			for {
				select {
				case <-ticker.C:
					s.RunSync()
				case <-s.stopChan:
					ticker.Stop()
					return
				}
			}
		}()
	})
}

// Stop gracefully shuts down the sync service. It is idempotent.
func (s *SyncService) Stop() {
	s.stopOnce.Do(func() {
		close(s.stopChan)
	})
}

// RunSync performs a single pass of the trust propagation and cache update.
func (s *SyncService) RunSync() {
	s.mu.Lock()
	defer s.mu.Unlock()

	log.Println("Starting Trust Propagation Sync...")

	// 1. Fetch latest tokens
	tokens := s.attestService.GetAttestations()

	// 2. Verify all attestations locally first to ensure atomicity later
	var verifiedClaims []*attestation.AttestationClaims
	for i, token := range tokens {
		claims, err := s.attestService.VerifyAndPeekIssuer(token)
		if err != nil {
			// Log index and length only — never log token content even truncated
			log.Printf("ERROR: Failed to verify attestation during sync (token index=%d length=%d): %v", i, len(token), err)
			continue
		}
		verifiedClaims = append(verifiedClaims, claims)
	}

	// 3. Atomically update engine edges and calculate fresh scores
	newScores := s.trustEngine.ReplaceEdgesAndCalculate(verifiedClaims)

	// 4. Fetch current fingerprints in cache
	currentFingerprints, err := s.edgeCache.ListTrustFingerprints()
	if err != nil {
		log.Printf("ERROR: Failed to list fingerprints from cache: %v", err)
		return
	}

	// 5. Sync scores to the edge verifier's cache
	updated := make(map[string]bool)
	for fingerprint, score := range newScores {
		// Mark as updated *before* attempting write to prevent accidental stale deletion on transient error
		updated[fingerprint] = true
		if err := s.edgeCache.SetTrustScore(fingerprint, verifier.TrustScore(score)); err != nil {
			log.Printf("ERROR: Failed to set trust score for %s: %v", fingerprint, err)
			continue
		}
	}

	// 6. Remove stale fingerprints (those present in cache but NOT in current engine results)
	for _, fp := range currentFingerprints {
		if !updated[fp] {
			if err := s.edgeCache.DeleteTrustScore(fp); err != nil {
				log.Printf("ERROR: Failed to delete stale fingerprint %s: %v", fp, err)
			}
		}
	}

	log.Printf("Sync complete. Updated scores for %d nodes.", len(newScores))
}
