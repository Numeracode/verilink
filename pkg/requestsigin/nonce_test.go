package requestsigin

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestNonceCache_FirstUse(t *testing.T) {
	c := NewNonceCache(time.Minute)
	defer c.Stop()

	if !c.CheckAndConsume("abc", "key1") {
		t.Fatal("expected true for first use")
	}
}

func TestNonceCache_DuplicateUse(t *testing.T) {
	c := NewNonceCache(time.Minute)
	defer c.Stop()

	c.CheckAndConsume("abc", "key1")
	if c.CheckAndConsume("abc", "key1") {
		t.Fatal("expected false for duplicate use")
	}
}

func TestNonceCache_DifferentKeyID(t *testing.T) {
	c := NewNonceCache(time.Minute)
	defer c.Stop()

	if !c.CheckAndConsume("abc", "key1") {
		t.Fatal("expected true for key1")
	}
	if !c.CheckAndConsume("abc", "key2") {
		t.Fatal("expected true for key2 — different key IDs should not collide")
	}
}

func TestNonceCache_Expiry(t *testing.T) {
	c := NewNonceCache(10 * time.Millisecond)
	defer c.Stop()

	if !c.CheckAndConsume("abc", "key1") {
		t.Fatal("expected true for first use")
	}

	time.Sleep(15 * time.Millisecond)

	if !c.CheckAndConsume("abc", "key1") {
		t.Fatal("expected true after nonce expired")
	}
}

func TestNonceCache_Stop(t *testing.T) {
	before := runtime.NumGoroutine()

	c := NewNonceCache(time.Minute)
	time.Sleep(10 * time.Millisecond)
	c.Stop()
	time.Sleep(50 * time.Millisecond)

	after := runtime.NumGoroutine()
	if after >= before+2 {
		t.Fatalf("goroutine leak: before=%d after=%d", before, after)
	}
}

func TestNonceCache_ConcurrentSafety(t *testing.T) {
	c := NewNonceCache(time.Minute)
	defer c.Stop()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c.CheckAndConsume("nonce", "key1")
		}(i)
	}
	wg.Wait()
}
