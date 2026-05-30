package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

type Server struct {
	service *attestation.Service
}

func (s *Server) SubmitHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Token string `json:"token"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.service.SubmitAttestation(req.Token); err != nil {
		log.Printf("Attestation submission failed: %v", err)
		http.Error(w, fmt.Sprintf("Forbidden: %v", err), http.StatusForbidden)
		return
	}

	w.WriteHeader(http.StatusAccepted)
	fmt.Fprintf(w, "Attestation accepted and verified")
}

func (s *Server) ListHandler(w http.ResponseWriter, r *http.Request) {
	attestations := s.service.GetAttestations()
	json.NewEncoder(w).Encode(attestations)
}

func main() {
	service := attestation.NewService()

	// 1. Setup a test trusted issuer for development
	// (In production, this would be loaded from a config or DID resolver)
	pubKey, privKey, _ := ed25519.GenerateKey(nil)
	issuerDID := "did:key:test-issuer"
	service.RegisterIssuer(issuerDID, pubKey)

	log.Printf("DEVELOPMENT MODE: Registered trusted issuer: %s", issuerDID)
	log.Printf("DEVELOPMENT MODE: Issuer Public Key (Hex): %s", hex.EncodeToString(pubKey))
	log.Printf("DEVELOPMENT MODE: Issuer Private Key (Hex): %s", hex.EncodeToString(privKey))

	server := &Server{service: service}

	http.HandleFunc("/v1/attestations/submit", server.SubmitHandler)
	http.HandleFunc("/v1/attestations", server.ListHandler)

	log.Println("Verilink Attestation Service running on :8082")
	log.Fatal(http.ListenAndServe(":8082", nil))
}
