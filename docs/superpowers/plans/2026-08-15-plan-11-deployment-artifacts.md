# Plan 11 — Deployment artifacts

**Depends on:** Plans 1–10 (all merged to `main`)

**Target branch:** `feat/deployment-artifacts`

**Goal:** Production-ready deployment artifacts for all VeriLink surfaces: distroless Docker images, self-host Docker Compose, Helm charts for Kubernetes, systemd unit for bare-metal edge, and static binary release tooling.

**Maps to:** productization design §10 + §13 step 15.

**Out of scope:** Actual CI/CD pipeline for image publishing (separate effort); hosted SaaS provisioning (OCI infra); backup/restore drill (step 20).

---

## Context

| Exists (from PR B) | Missing |
|---|---|
| `Dockerfile.edge-verifier`, `Dockerfile.trust-engine`, `control-plane/Dockerfile` (alpine-based, dev) | **Production distroless** Dockerfiles for Go services |
| `docker-compose.dev.yml` (dev stack with hot reload) | **`docker/docker-compose.self-host.yml`** (production self-host: all services + Postgres + Redis, no dev mounts) |
| `scripts/dev-up.sh` | **`helm/`** charts for Kubernetes deployment |
| | **`systemd/verilink-edge.service`** + sample config for bare-metal |
| | **`scripts/build-release.sh`** — static binary builds (x86_64 + aarch64) with checksums + SBOM |

---

## Locked decisions

1. **Distroless for Go production images:** Use `gcr.io/distroless/static-debian12` as the runtime base for `edge-verifier` and `trust-engine`. No shell, no package manager, smallest attack surface. The existing alpine Dockerfiles remain for dev (PR B); production Dockerfiles live in `docker/`.

2. **Self-host Compose is distinct from dev Compose:** `docker/docker-compose.self-host.yml` is a standalone production stack: no source mounts, no hot reload, no `BOOTSTRAP_SEED=1` auto-seed, health checks on all services, restart policies, resource limits. Postgres and Redis use upstream images with persistent volumes.

3. **Helm chart structure:** Single chart `helm/verilink/` with subcharts for `control-plane`, `trust-engine`, `edge-verifier`, `postgres` (bitnami upstream), `redis` (bitnami upstream). `edge.kind` configurable (`Deployment` | `DaemonSet`). HPA on control-plane and trust-engine. Values file for self-host (single-tenant) vs hosted (multi-tenant) presets.

4. **Systemd for bare-metal edge:** `systemd/verilink-edge.service` runs the static binary as a systemd service with sandboxing (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`). Sample config at `systemd/verilink-edge.env.example`.

5. **Static binary release:** `scripts/build-release.sh` cross-compiles `CGO_ENABLED=0` binaries for `linux/amd64` and `linux/arm64` for both `edge-verifier` and `trust-engine`. Outputs to `dist/` with SHA256 checksums and a CycloneDX SBOM. GitHub Releases upload is manual (CI pipeline is a separate effort).

6. **No new migrations or code changes:** This plan is purely infrastructure artifacts. No Go or TS source changes. All existing env vars and flags are documented in the Helm values and systemd config.

---

## PR split

### Single PR — all deployment artifacts

- `docker/Dockerfile.edge-verifier` — distroless production image
- `docker/Dockerfile.trust-engine` — distroless production image
- `docker/Dockerfile.control-plane` — production Node image (multi-stage, slim)
- `docker/docker-compose.self-host.yml` — self-host stack
- `helm/verilink/` — Helm chart (Chart.yaml, values.yaml, templates/)
- `systemd/verilink-edge.service` + `systemd/verilink-edge.env.example`
- `scripts/build-release.sh` — static binary builder with checksums + SBOM
- `.github/workflows/release.yml` — GitHub Actions for tagged releases (build + checksums + SBOM, upload to GitHub Releases)

---

## Verification

- `docker build` succeeds for all three production Dockerfiles
- `docker compose -f docker/docker-compose.self-host.yml config` validates the compose file
- `helm lint helm/verilink/` passes
- `helm template helm/verilink/` renders without errors for both `edge.kind: Deployment` and `edge.kind: DaemonSet`
- `scripts/build-release.sh` produces binaries for both architectures with checksums
- `systemd-analyze verify systemd/verilink-edge.service` passes
- Repository gates: clean workspace, `go build ./...`, `go test ./...`, control-plane `tsc --noEmit` + `npm run test:unit`

---

## Acceptance (maps to design §10.1)

- [ ] Production distroless Dockerfiles for edge-verifier and trust-engine
- [ ] Production Dockerfile for control-plane
- [ ] `docker/docker-compose.self-host.yml` — all services + Postgres + Redis, health checks, restart policies
- [ ] `helm/verilink/` — configurable `edge.kind`, HPAs, upstream Postgres/Redis
- [ ] `systemd/verilink-edge.service` + sample config with sandboxing
- [ ] `scripts/build-release.sh` — static binaries (amd64 + arm64) with checksums + SBOM
- [ ] GitHub Actions release workflow
