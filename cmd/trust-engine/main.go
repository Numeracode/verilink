package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"

	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

// newGRPCServer creates a gRPC server with panic recovery interceptors,
// registers the TrustEngine + health services, and returns the server +
// health service handle. Used by both production (main) and tests so the
// interceptor + registration path is identical.
func newGRPCServer() (*grpc.Server, *health.Server) {
	grpcSrv := grpc.NewServer(
		grpc.UnaryInterceptor(unaryPanicRecovery),
		grpc.StreamInterceptor(streamPanicRecovery),
	)
	trustpb.RegisterTrustEngineServer(grpcSrv, &server{})

	healthSrv := health.NewServer()
	healthSrv.SetServingStatus(trustpb.TrustEngine_ServiceDesc.ServiceName, healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(grpcSrv, healthSrv)

	return grpcSrv, healthSrv
}

func main() {
	grpcPort := flag.Int("grpc-port", 9091, "gRPC listen port")
	httpPort := flag.Int("http-port", 8086, "HTTP /healthz listen port")
	ed25519PubHex := flag.String("ed25519-public-key-hex", "", "hex-encoded Ed25519 public key (REQUIRED)")
	logLevel := flag.String("log-level", "info", "log level (info, debug)")
	flag.Parse()

	if *ed25519PubHex == "" {
		fmt.Fprintln(os.Stderr, "error: --ed25519-public-key-hex is required")
		flag.Usage()
		os.Exit(1)
	}
	if _, err := hex.DecodeString(*ed25519PubHex); err != nil {
		fmt.Fprintf(os.Stderr, "error: --ed25519-public-key-hex is not valid hex: %v\n", err)
		os.Exit(1)
	}

	if *logLevel == "debug" {
		log.SetFlags(log.LstdFlags | log.Lshortfile)
	}

	grpcAddr := fmt.Sprintf(":%d", *grpcPort)
	httpAddr := fmt.Sprintf(":%d", *httpPort)

	lis, err := net.Listen("tcp", grpcAddr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	grpcSrv, healthSrv := newGRPCServer()

	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", healthHandler)
	httpSrv := &http.Server{
		Addr:              httpAddr,
		Handler:           httpMux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		log.Printf("trust-engine HTTP /healthz on %s", httpAddr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-sigCh
		log.Printf("trust-engine shutting down...")

		healthSrv.SetServingStatus("verilink.trust.v1.TrustEngine", healthpb.HealthCheckResponse_NOT_SERVING)

		var wg sync.WaitGroup
		wg.Add(2)

		go func() {
			defer wg.Done()
			stopped := make(chan struct{})
			go func() {
				grpcSrv.GracefulStop()
				close(stopped)
			}()
			select {
			case <-stopped:
			case <-time.After(10 * time.Second):
				log.Printf("gRPC GracefulStop timed out, forcing Stop()")
				grpcSrv.Stop()
			}
		}()

		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := httpSrv.Shutdown(ctx); err != nil {
				log.Printf("http shutdown: %v", err)
			}
		}()

		wg.Wait()
	}()

	log.Printf("trust-engine listening on %s", grpcAddr)
	if err := grpcSrv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}

	<-shutdownDone
}

func unaryPanicRecovery(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic recovered in %s: %v", info.FullMethod, r)
			err = status.Errorf(codes.Internal, "internal error")
		}
	}()
	return handler(ctx, req)
}

func streamPanicRecovery(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic recovered in %s: %v", info.FullMethod, r)
			err = status.Errorf(codes.Internal, "internal error")
		}
	}()
	return handler(srv, ss)
}

// healthHandler is the HTTP /healthz handler. Package-level so tests can
// call it directly without recreating the handler logic.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
