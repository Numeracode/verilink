// keygen prints a fresh Ed25519 keypair as environment variable assignments.
// Run once and store the output in your credential manager:
//
//	verilink-keygen >> .env
package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"log"
)

func main() {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		log.Fatalf("keygen: %v", err)
	}

	fmt.Printf("VERILINK_ISSUER_PUBLIC_KEY=%s\n", hex.EncodeToString(pub))
	fmt.Printf("VERILINK_ISSUER_PRIVATE_KEY=%s\n", hex.EncodeToString(priv))
	fmt.Println("# Store these values in your credential manager.")
	fmt.Println("# The private key is 64 bytes (seed + public key). Keep it private.")
}
