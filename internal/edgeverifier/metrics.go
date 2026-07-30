package edgeverifier

import (
	"sync"
	"sync/atomic"
	"time"
)

// Metrics holds Plan 8 minimum edge sync / WAL counters and gauges.
// Values are process-local atomics suitable for tests and a future /metrics export.
type Metrics struct {
	DecisionsDropped atomic.Uint64
	WALBytes         atomic.Int64
	SnapshotHW       atomic.Int64
	SSEBytesAgeNs    atomic.Int64 // last observed age in nanoseconds

	mu             sync.Mutex
	syncReconnects map[string]*atomic.Uint64
}

// NewMetrics returns an empty metrics bag.
func NewMetrics() *Metrics {
	return &Metrics{syncReconnects: make(map[string]*atomic.Uint64)}
}

// IncSyncReconnect increments sync_reconnects_total for reason.
func (m *Metrics) IncSyncReconnect(reason string) {
	if m == nil {
		return
	}
	if reason == "" {
		reason = "unknown"
	}
	m.mu.Lock()
	c, ok := m.syncReconnects[reason]
	if !ok {
		c = &atomic.Uint64{}
		m.syncReconnects[reason] = c
	}
	m.mu.Unlock()
	c.Add(1)
}

// SyncReconnects returns a copy of reconnect counters by reason.
func (m *Metrics) SyncReconnects() map[string]uint64 {
	out := make(map[string]uint64)
	if m == nil {
		return out
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, c := range m.syncReconnects {
		out[k] = c.Load()
	}
	return out
}

// ObserveStore refreshes snapshot_high_water and sse_bytes_age gauges from store.
func (m *Metrics) ObserveStore(store *Store) {
	if m == nil || store == nil {
		return
	}
	m.SnapshotHW.Store(store.HighWater())
	m.SSEBytesAgeNs.Store(store.BytesAge().Nanoseconds())
}

// SSEBytesAge returns the last observed SSE bytes age.
func (m *Metrics) SSEBytesAge() time.Duration {
	if m == nil {
		return 0
	}
	return time.Duration(m.SSEBytesAgeNs.Load())
}
