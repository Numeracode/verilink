# Specification: Transitive Trust Graph Algorithm (NHI-TG-03)

## Overview
The Verilink Trust Graph converts a collection of fragmented behavioural attestations into a single, actionable **Trust Score (0-100)** for any agent fingerprint.

## Definitions
- **Node:** An entity (Issuer) or an agent fingerprint (Subject).
- **Edge:** A verified attestation from Node A to Node B.
- **Root of Trust:** A set of manually verified "Anchor Entities" (e.g., Fortune 500 companies, known banks).
- **Distance (Hops):** The number of edges between a Root of Trust and the target agent.

## The Calculation (VeriRank)
The trust score $T(s)$ for a subject $s$ is calculated using a weighted transitive propagation model:

### 1. Direct Trust
If a Root of Trust $R$ issues a direct attestation for Subject $s$:
$$T(s) = \text{attestation\_score} \times \text{staleness\_decay}$$

### 2. Transitive (Multi-Hop) Trust
If $R$ trusts $A$, and $A$ trusts $s$:
$$T(s) = T(A) \times \text{attestation\_score\_from\_A} \times \text{distance\_decay}^d$$

### 3. Decay Factors
- **Distance Decay:** $0.8^d$ (where $d$ is the number of hops). Trust rapidly decreases as we move away from the Roots of Trust.
- **Time Decay:** $e^{-\lambda t}$ (where $t$ is the age of the attestation in days). Attestations older than 180 days lose significant weight.

### 4. Conflict Resolution
If multiple paths lead to different scores for the same subject:
- **Positive Consensus:** Maximum trust path — the highest-scoring path wins. This matches the tested implementation in `pkg/trust/engine.go` (the `contribution > currentScore` check at line 160). A weighted-average consensus is a documented future redesign; v1 locks the max-path algorithm.
- **Negative Override:** Any "Negative Incident" attestation from a highly trusted node ($T > 80$) immediately drops the target's score to 0 (Blacklist).

## Algorithm Flow
1.  **Initialize:** Load all verified attestations from the Attestation Service.
2.  **Breadth-First Search (BFS):** Starting from Roots of Trust, traverse the graph to a max depth of 4 hops.
3.  **Accumulate:** Calculate derived scores for every reached node.
4.  **Finalize:** Apply conflict resolution and time decay.
5.  **Export:** Sync final scores to the Edge Verifier cache.

## Success Criteria
- [ ] Multi-hop trust (R -> A -> B) is calculated correctly.
- [ ] A negative report from a trusted node correctly blacklists the subject.
- [ ] Scores decay as attestations get older.
- [ ] Computational complexity remains manageable for 100k+ nodes.
