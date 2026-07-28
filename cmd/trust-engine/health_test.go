package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/messagesgoel-blip/verilink/internal/trustengine"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

func TestServer_Health(t *testing.T) {
	_, conn, cleanup := startTestServer(t)
	defer cleanup()

	healthClient := healthpb.NewHealthClient(conn)
	res, err := healthClient.Check(context.Background(), &healthpb.HealthCheckRequest{
		Service: "verilink.trust.v1.TrustEngine",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != healthpb.HealthCheckResponse_SERVING {
		t.Errorf("expected SERVING, got %s", res.Status)
	}
}

func TestServer_HTTPHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/healthz", nil)
	trustengine.HealthHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if rec.Body.String() != "ok" {
		t.Errorf("expected 'ok', got %s", rec.Body.String())
	}
}
