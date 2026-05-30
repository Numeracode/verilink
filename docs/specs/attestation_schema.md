# Specification: Behavioural Attestations (NHI-AT-02)

## Overview
A **Behavioural Attestation** is a cryptographically signed statement made by a trusted entity (the "Attestor") about the observed behaviour of an autonomous agent (the "Subject"). 

Unlike traditional identity systems that focus on *who* the agent is, Verilink focuses on *what* the agent has done.

## Objectives
1.  **Immutability:** Once signed, the attestation cannot be altered.
2.  **Accountability:** The identity of the Attestor must be verifiable via their public key.
3.  **Standardization:** Use a common taxonomy for reporting facts (e.g., successful transactions, disputes).

## Data Structure (The Payload)
We use a **JSON Web Signature (JWS)** structure. The payload (the "Claims") follows this schema:

### Claims (Standard JWT)
*   `iss` (Issuer): The Decentralized Identifier (DID) or Public Key Hash of the Attestor.
*   `sub` (Subject): The **Verilink Fingerprint** of the agent (from NHI-FP-01).
*   `iat` (Issued At): Unix timestamp.
*   `exp` (Expiration): Optional timestamp after which the attestation is stale.

### Verilink-Specific Claims (`vli`)
The core behavioural facts are stored in the `vli` object:

```json
{
  "iss": "did:key:<attestor-did>",
  "sub": "VERI-FP-SHA256-...",
  "iat": 1713094800,
  "vli": {
    "type": "transaction_summary",
    "facts": {
      "successful_invoices": 142,
      "dispute_count": 0,
      "avg_response_ms": 450,
      "last_activity": "2026-04-13T14:00:00Z"
    },
    "trust_level_delta": 10
  }
}
```

## Supported Attestation Types
1.  **Transaction Summary:** High-level performance metrics (invoices, payments, latency).
2.  **KYB Verification:** Confirmation that the agent is bound to a verified business entity.
3.  **Security Audit:** Confirmation of the agent's underlying model/software security.
4.  **Negative Incident:** Reporting a specific breach of protocol or fraudulent attempt.

## Signing & Verification
- **Algorithm:** `EdDSA` (Ed25519) is preferred for high performance and short keys.
- **Verification:** Any node in the network can verify the attestation by:
    1.  Fetching the Attestor's public key (via DID or known list).
    2.  Verifying the JWS signature.
    3.  Confirming the `exp` claim hasn't passed.

## Implementation Path
A Go package `pkg/attestation` will be created to handle the encoding, signing, and decoding of these structures.
