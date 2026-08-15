# Plan 12 — Clients

**Depends on:** Plans 1–11 (all merged)

**Target branch:** `feat/clients-step-16`

**Goal:** Finalize the Go and Node clients for v1: add `Idempotency-Key` coverage to RFC 9421 signing, update default URLs, convert the Node client to TypeScript with published types, and prepare `@verilink/node` for npm publish.

**Maps to:** productization design §12 + §13 step 16.

---

## Context

| Exists | Missing |
|---|---|
| Go client: `SubmitAttestation`, `GetTrustScore`, `SignRequest`, `MakeRequest` | **`Idempotency-Key` coverage** in the signature base; `SignRequestWithIdempotencyKey` helper |
| Go client: tests for signing + round-trip | **Idempotency-Key round-trip test** |
| Node client: `VeriLinkClient`, `signRequest`, `verifySignatureInput` (JS, CommonJS) | **TypeScript conversion** with `.d.ts` types; `Idempotency-Key` coverage |
| Node client: `@numeracode/verilink-client` (private, v0.0.0) | **Rename to `@verilink/node`**; npm publish config (public, ESM + CJS, types) |
| Node client: signing test suite | **Idempotency-Key round-trip test**; TS compilation |

---

## Locked decisions

1. **Idempotency-Key coverage:** When an `Idempotency-Key` header is present on a signed request, it MUST be included in the RFC 9421 signature base string as a covered component (`"idempotency-key": <value>`). Both Go and Node clients add a `SignRequestWithIdempotencyKey(req, keyLabel, idempotencyKey)` helper that sets the header and includes it in the signature. The existing `SignRequest` is unchanged; the new helper wraps it.

2. **Go client default URL:** Update the doc comment default from `http://verilink-attest:8082` (legacy) to `https://api.verilink.ai` (hosted SaaS). The `AttestationURL` field is still required; this is documentation-only.

3. **Node client TypeScript conversion:** The client is rewritten in TypeScript (`index.ts`), compiled to both ESM (`dist/index.mjs`) and CJS (`dist/index.js`) with `.d.ts` type declarations. `package.json` uses `exports` for dual-module support. The existing JS test is converted to a TS test.

4. **Package name:** `@verilink/node` (scoped, public). Version `0.1.0`. `publishConfig` set to public. The old `@numeracode/verilink-client` name is abandoned (it was private v0.0.0).

5. **No breaking API changes:** The existing `VeriLinkClient`, `signRequest`, `verifySignatureInput`, `computeContentDigest`, `buildSignatureBase` APIs are preserved. The only addition is `SignRequestWithIdempotencyKey` / `signRequestWithIdempotencyKey`.

---

## PR split

### Single PR — both clients

**Go client:**
- `client/go/verilink.go`: add `SignRequestWithIdempotencyKey(req, keyLabel, idempotencyKey)` — sets `Idempotency-Key` header, includes it in the signature base
- `client/go/verilink_test.go`: add `TestSignRequestWithIdempotencyKey` + round-trip verification
- Update doc comments with new default URL

**Node client:**
- `client/node/index.ts`: TypeScript rewrite of `index.js` with full type annotations
- `client/node/index.js`: removed (replaced by compiled output)
- `client/node/tsconfig.json`: build config (ESM + CJS + declarations)
- `client/node/package.json`: rename to `@verilink/node`, dual-module `exports`, `types`, `files`, `publishConfig`
- `client/node/test/signing.test.ts`: converted from JS to TS, add Idempotency-Key round-trip test
- `client/node/test/signing.test.js`: removed

---

## Verification

- `go test ./client/go/...` — all existing + new tests pass
- `cd client/node && npx tsc --noEmit` — type-checks
- `cd client/node && npm test` — all existing + new tests pass
- `cd client/node && npm run build` — produces `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts`
- Repository gates: `go build ./...`, `go test ./...`, `tsc --noEmit`

---

## Acceptance (maps to design §12)

- [ ] Go client has `Idempotency-Key` coverage in RFC 9421 signing
- [ ] Go client default URL updated in docs
- [ ] Node client is TypeScript with published types
- [ ] Node client renamed to `@verilink/node` with npm publish config
- [ ] Node client has `Idempotency-Key` coverage
- [ ] All existing tests preserved and passing
