# VeriLink

VeriLink is an AI-agent identity and attestation toolkit for services that need deterministic trust decisions before accepting agent-originated work. It fingerprints requests, verifies signed JWS attestations, calculates trust scores, and lets an edge verifier allow or deny traffic before it reaches an application.

VeriLink is currently a Go module with source clients. It is not a hosted SaaS, and it does not publish an npm package yet.

## What is included

- `cmd/attestation-service`: HTTP service for attestation submission and listing.
- `cmd/edge-verifier`: reverse proxy that fingerprints inbound requests and enforces a trust threshold.
- `cmd/keygen`: helper that prints a fresh Ed25519 keypair for local setup.
- `pkg/fingerprint`: deterministic request fingerprint generation.
- `pkg/attestation`: JWS signing and verification helpers.
- `pkg/trust`: trust scoring and propagation logic.
- `client/go`: lightweight Go client for service integrations.
- `client/node`: lightweight CommonJS Node client for service integrations.

## Requirements

- Go 1.22 or newer.
- Node 18 or newer if you use `client/node`.

## Install

Clone the repository:

```bash
git clone https://github.com/messagesgoel-blip/verilink.git
cd verilink
```

Run the test suite:

```bash
go test ./...
```

Install the service binaries from the public module:

```bash
go install github.com/messagesgoel-blip/verilink/cmd/attestation-service@latest
go install github.com/messagesgoel-blip/verilink/cmd/edge-verifier@latest
go install github.com/messagesgoel-blip/verilink/cmd/keygen@latest
```

Install the Go client package in a consumer module:

```bash
go get github.com/messagesgoel-blip/verilink/client/go
```

Node package status: there is no published npm package yet. Use `client/node/index.js` from the repository source until a package is published.

## Quickstart

Start the attestation service:

```bash
go run ./cmd/attestation-service
```

In another terminal, start the edge verifier demo:

```bash
go run ./cmd/edge-verifier
```

Send a trusted demo request. The demo verifier pre-seeds the fingerprint produced by `X-JA4-Fingerprint: test-ja4`, HTTP/1.1, and `User-Agent: TestAgent`.

```bash
curl -i \
  -H 'X-JA4-Fingerprint: test-ja4' \
  -H 'User-Agent: TestAgent' \
  http://localhost:8080/
```

Expected result: `200 OK` with `X-Verilink-Status: Allowed`.

Send an untrusted demo request:

```bash
curl -i \
  -H 'X-JA4-Fingerprint: test-ja4' \
  -H 'User-Agent: UnknownAgent' \
  http://localhost:8080/
```

Expected result: `403 Forbidden` with `X-Verilink-Status: Denied`.

## Attestation service

The development service listens on `:8082` and accepts signed attestations:

```http
POST /v1/attestations/submit
Content-Type: application/json

{"token":"<signed-jws>"}
```

It also exposes the accepted attestations:

```http
GET /v1/attestations
```

The current public snapshot runs with an in-memory issuer registry and in-memory trust store. Production deployments should register trusted issuers explicitly, keep signing keys in a credential manager, and back trust state with durable storage.

## Edge verifier

The demo edge verifier listens on `:8080`, fingerprints the request using:

- `X-JA4-Fingerprint`
- request protocol
- `User-Agent`

If the fingerprint's score is below the trust threshold, the verifier returns `403`. Otherwise it proxies the request to its backend.

The demo command starts an in-process mock backend on `:8081`. It is suitable for local evaluation, not production traffic.

## Go client

Add the client to a Go service:

```bash
go get github.com/messagesgoel-blip/verilink/client/go
```

Use it from code:

```go
package main

import (
	"context"
	"crypto/ed25519"
	"log"

	verilink "github.com/messagesgoel-blip/verilink/client/go"
)

func main() {
	var privateKey ed25519.PrivateKey // Load from your credential manager.

	client, err := verilink.NewClient(verilink.Config{
		AttestationURL: "http://localhost:8082",
		IssuerDID:      "did:key:your-service",
		PrivateKey:     privateKey,
	})
	if err != nil {
		log.Fatal(err)
	}

	err = client.SubmitAttestation(
		context.Background(),
		"did:key:agent",
		map[string]any{"action": "review_completed"},
		10,
	)
	if err != nil {
		log.Fatal(err)
	}
}
```

## Node client

There is no npm install command yet. Copy or vendor `client/node/index.js`, then load it from your service:

```js
const { VeriLinkClient } = require('./client/node');

const client = VeriLinkClient.fromEnv();
await client.submitAttestation('did:key:agent', { action: 'review_completed' });

const score = await client.getTrustScore('fingerprint-sha256');
const trusted = await client.isTrusted('fingerprint-sha256', 50);
```

Required environment variables:

```bash
export VERILINK_ATTESTATION_URL=http://localhost:8082
export VERILINK_ISSUER_DID=did:key:your-service
export VERILINK_ISSUER_PRIVATE_KEY=<128-char-hex-ed25519-private-key>
```

Generate a development keypair with:

```bash
go run ./cmd/keygen
```

## Homepage / directory install command

VeriLink is a toolkit plus service binaries, not a single end-user CLI. For product directories and homepage cards, use:

```text
GitHub-only, no single install command
```

If you need a concrete developer command, use the relevant integration target:

```bash
go get github.com/messagesgoel-blip/verilink/client/go
go install github.com/messagesgoel-blip/verilink/cmd/attestation-service@latest
go install github.com/messagesgoel-blip/verilink/cmd/edge-verifier@latest
go install github.com/messagesgoel-blip/verilink/cmd/keygen@latest
```

## License

MIT. See [LICENSE](LICENSE).
