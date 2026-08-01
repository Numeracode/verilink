# VeriLink Dashboard

Vite + React SPA for provider, agent-builder, and admin views (Plan 9).

Canonical repo: `/srv/storage/repo/VeriLink/`

## Dev

```bash
# Terminal 1 — control plane
cd /srv/storage/repo/VeriLink/control-plane && npm run dev

# Terminal 2 — dashboard (proxies /v1 to CP)
cd /srv/storage/repo/VeriLink/dashboard && npm install && npm run dev
```

Env (`.env.local` under `dashboard/`):

| Variable | Notes |
|----------|--------|
| `VITE_API_BASE_URL` | Empty in dev (use Vite proxy). Absolute CP origin in production builds if not same-origin. |
| `VITE_AUTH_MODE` | `apikey` (CI/local) or `oidc` (Clerk PKCE — production). |
| `VITE_OIDC_ISSUER_URL` / `VITE_OIDC_CLIENT_ID` | Required when `oidc`. |
| `VITE_DEV_PROXY_TARGET` | Default `http://127.0.0.1:3000` (loaded via Vite `loadEnv`). |

## Production

```bash
cd /srv/storage/repo/VeriLink/dashboard && npm ci && npm run build
# Serve via control plane:
cd /srv/storage/repo/VeriLink/control-plane
DASHBOARD_DIST_PATH=/srv/storage/repo/VeriLink/dashboard/dist npm start
```

When `DASHBOARD_DIST_PATH` is unset, the control plane resolves `dashboard/dist` relative to this module (monorepo layout), independent of process cwd.
Set `DASHBOARD_DIST_PATH=off` (or `false` / `0` / `-` / `disabled`) to skip SPA mounting.

## Auth

- **apikey:** paste a `vrl_` + 64 hex key (68 chars); held in memory only (not Web Storage); sent as `Authorization: Bearer`.
- **oidc:** Authorization Code + PKCE; discovery via `/.well-known/openid-configuration`; access token held in memory.
- Active tenant: `X-Tenant-Id` on all API calls (selector in shell; tenant id may use sessionStorage).
