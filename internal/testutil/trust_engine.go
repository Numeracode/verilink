package testutil

import (
	"net"
	"sync"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/messagesgoel-blip/verilink/internal/trustengine"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

// TrustEngineHarness wraps a live gRPC TrustEngine for integration tests.
type TrustEngineHarness struct {
	Client trustpb.TrustEngineClient
	grpc   *grpc.Server
	conn   *grpc.ClientConn
	once   sync.Once
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
		s.Stop()
		t.Fatalf("failed to connect: %v", err)
	}

	h := &TrustEngineHarness{
		Client: trustpb.NewTrustEngineClient(conn),
		grpc:   s,
		conn:   conn,
	}
	t.Cleanup(h.Stop)
	return h
}
