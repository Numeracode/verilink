package trustengine

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"

	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

// Config holds trust-engine listen settings. Addr is consumed by Run callers;
// NewServer currently does not use it (reserved for future options).
type Config struct {
	Addr string
}

// NewServer creates a gRPC server with panic recovery interceptors, registers
// the TrustEngine + health services, and returns the server + health handle.
// Used by both production (cmd/trust-engine) and tests so the interceptor +
// registration path is identical.
func NewServer() (*grpc.Server, *health.Server) {
	grpcSrv := grpc.NewServer(
		grpc.UnaryInterceptor(UnaryPanicRecovery),
		grpc.StreamInterceptor(StreamPanicRecovery),
	)
	trustpb.RegisterTrustEngineServer(grpcSrv, &server{})

	healthSrv := health.NewServer()
	healthSrv.SetServingStatus(trustpb.TrustEngine_ServiceDesc.ServiceName, healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(grpcSrv, healthSrv)

	return grpcSrv, healthSrv
}

// Run listens on addr and serves s until the server stops.
func Run(s *grpc.Server, addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	log.Printf("Trust engine listening on %s", addr)
	return s.Serve(lis)
}

// HealthHandler is the HTTP /healthz handler.
func HealthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// UnaryPanicRecovery recovers from unary handler panics and returns codes.Internal.
func UnaryPanicRecovery(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic recovered in %s: %v", info.FullMethod, r)
			err = status.Errorf(codes.Internal, "internal error")
		}
	}()
	return handler(ctx, req)
}

// StreamPanicRecovery recovers from stream handler panics and returns codes.Internal.
func StreamPanicRecovery(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic recovered in %s: %v", info.FullMethod, r)
			err = status.Errorf(codes.Internal, "internal error")
		}
	}()
	return handler(srv, ss)
}
