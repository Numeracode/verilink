package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	"github.com/messagesgoel-blip/verilink/internal/trustengine"
)

func main() {
	grpcPort := flag.Int("grpc-port", 9091, "gRPC listen port")
	httpPort := flag.Int("http-port", 8086, "HTTP /healthz listen port")
	logLevel := flag.String("log-level", "info", "log level (info, debug)")
	flag.Parse()

	if *logLevel == "debug" {
		log.SetFlags(log.LstdFlags | log.Lshortfile)
	}

	grpcAddr := fmt.Sprintf(":%d", *grpcPort)
	httpAddr := fmt.Sprintf(":%d", *httpPort)

	grpcSrv, healthSrv := trustengine.NewServer()

	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", trustengine.HealthHandler)
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

	if err := trustengine.Run(grpcSrv, grpcAddr); err != nil {
		log.Fatalf("serve: %v", err)
	}

	<-shutdownDone
}
