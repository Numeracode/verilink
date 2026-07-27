package requestsigin

import (
	"sync"
	"time"
)

// NonceCache is a thread-safe, in-memory nonce replay cache with TTL expiry.
type NonceCache struct {
	mu       sync.RWMutex
	seen     map[string]time.Time
	ttl      time.Duration
	stopCh   chan struct{}
	stopOnce sync.Once
}

// NewNonceCache creates a NonceCache with the given TTL and starts a background
// sweeper goroutine that cleans up expired entries every ttl/2.
func NewNonceCache(ttl time.Duration) *NonceCache {
	c := &NonceCache{
		seen:   make(map[string]time.Time),
		ttl:    ttl,
		stopCh: make(chan struct{}),
	}
	go c.sweep()
	return c
}

// CheckAndConsume atomically checks if a nonce has been seen for the given key ID.
// Returns true if the nonce is new (and consumes it); false if already seen or expired.
func (c *NonceCache) CheckAndConsume(nonce, keyid string) bool {
	key := keyid + ":" + nonce
	now := time.Now()
	expiry := now.Add(c.ttl)

	c.mu.Lock()
	defer c.mu.Unlock()

	if exp, ok := c.seen[key]; ok && now.Before(exp) {
		return false
	}
	c.seen[key] = expiry
	return true
}

// Stop stops the background sweeper goroutine.
func (c *NonceCache) Stop() {
	c.stopOnce.Do(func() { close(c.stopCh) })
}

// sweep periodically removes expired entries. Runs until Stop() is called.
func (c *NonceCache) sweep() {
	interval := c.ttl / 2
	if interval < time.Millisecond {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			now := time.Now()
			c.mu.Lock()
			for k, exp := range c.seen {
				if now.After(exp) {
					delete(c.seen, k)
				}
			}
			c.mu.Unlock()
		}
	}
}
