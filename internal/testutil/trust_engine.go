package testutil

import (
	"errors"
	"log"
	"net"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/messagesgoel-blip/verilink/internal/trustengine"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

// TrustEngineHarness wraps a live gRPC TrustEngine for integration tests.
type TrustEngineHarness struct {
	Client    trustpb.TrustEngineClient
	grpc      *grpc.Server
	conn      *grpc.ClientConn
	lis       net.Listener
	serveDone chan struct{}
	once      sync.Once
}

// Stop closes the client connection and stops the gRPC server.
func (h *TrustEngineHarness) Stop() {
	h.once.Do(func() {
		if h.conn != nil {
			_ = h.conn.Close()
		}
		if h.grpc != nil {
			h.grpc.Stop()
		}
		if h.lis != nil {
			_ = h.lis.Close()
		}
		// Ensure the Serve goroutine has exited before cleanup completes.
		// This prevents intermittent panics/errors like "log in goroutine after test has completed".
		if h.serveDone != nil {
			select {
			case <-h.serveDone:
			case <-time.After(5 * time.Second):
				// Best-effort: don't block tests indefinitely.
			}
		}
	})
}

// StartTrustEngine starts a TrustEngine gRPC server on a random local port
// using the same NewServer path as production.
func StartTrustEngine(t *testing.T) *TrustEngineHarness {
	t.Helper()

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	s, _ := trustengine.NewServer()
	serveDone := make(chan struct{})

	go func() {
		defer close(serveDone)
		if serveErr := s.Serve(lis); serveErr != nil && !errors.Is(serveErr, grpc.ErrServerStopped) {
			// Don't call testing.T from a goroutine: cleanup may run after the
			// test completes, causing "testing.T has already finished".
			log.Printf("trust-engine server stopped: %v", serveErr)
		}
	}()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		s.Stop()
		_ = lis.Close()
		t.Fatalf("failed to connect: %v", err)
	}

	h := &TrustEngineHarness{
		Client:    trustpb.NewTrustEngineClient(conn),
		grpc:      s,
		conn:      conn,
		lis:       lis,
		serveDone: serveDone,
	}
	t.Cleanup(h.Stop)
	return h
}
