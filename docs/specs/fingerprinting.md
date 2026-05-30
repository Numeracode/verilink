# Specification: Agent Fingerprinting (NHI-FP-01)

## Overview
To provide a decentralized trust layer for agents, we must first be able to uniquely identify them without requiring them to register an identity. This specification defines a multi-layered, deterministic "Fingerprint" that can be computed from any incoming API request.

## Objectives
1.  **Determinism:** The same agent should generate the same ID across multiple requests.
2.  **Privacy:** Fingerprints should not expose sensitive information about the underlying agent's owner unless explicitly permissioned.
3.  **Resistance to Spoofing:** Minor header changes should not easily allow an agent to assume a new identity.

## Fingerprint Composition
The fingerprint is a SHA-256 hash of a canonicalized JSON structure containing the following layers:

### 1. Network Layer (JA4 TLS Fingerprint)
The [JA4 TLS Fingerprint](https://github.com/Fox-IT/ja4) provides a deterministic identifier based on the TLS handshake parameters. This is extremely resistant to tampering as it is part of the transport layer.
*   **JA4 Fingerprint:** `ja4_raw_string` (e.g., `t13d311100_0013_150a`)

### 2. Protocol Layer (HTTP/2 or HTTP/3)
For modern agents, we capture the HTTP/2 frame and flow control settings.
*   **Header Order:** Canonical order of standard headers.
*   **Protocol Version:** `h2` or `h3`.

### 3. Identity Layer (Agent-Specific Headers)
While we don't require registration, we monitor for the presence of specific agent headers that may be self-identified:
*   `X-Agent-ID`: If an agent self-declares an ID, we include its hash in the fingerprint as a cross-check.
*   `User-Agent`: Standard but easily spoofed, used only for low-weight correlation.

### 4. Cryptographic Layer (Optional Attestation)
If the agent provides a cryptographic signature (e.g., via the Agent Identity Protocol IETF draft), the **Public Key Hash** becomes the primary component of the fingerprint.

## Fingerprint Generation Algorithm
1.  **Collect Input:** Gather JA4, Header-Order-Hash, and Public-Key (if available).
2.  **Canonicalize:**
    ```json
    {
      "ja4": "t13d311100_0013_150a",
      "headers": "9ae816...",
      "key_hash": "optional_sha256_of_pubkey"
    }
    ```
3.  **Hash:** `VERI-FP-SHA256(canonical_json)`.

## Implementation Path
The first implementation will be in **Go**, designed to run as a high-performance module within the **Edge Verifier proxy**.

## Success Criteria
- [ ] Unique ID remains stable for the same agent across 1,000 requests.
- [ ] Computation of the fingerprint takes <100 microseconds.
- [ ] No PII (Personal Identifiable Information) is stored in the fingerprint.
