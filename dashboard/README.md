# VeriLink Dashboard

Vite + React SPA for provider, agent-builder, and admin views (Plan 9).

## Dev

```bash
# Terminal 1 — control plane
cd control-plane && npm run dev

# Terminal 2 — dashboard (proxies /v1 to CP)
cd dashboard && npm install && npm run dev
```

Env (`.env.local`):

| Variable | Notes |
|----------|--------|
| `VITE_API_BASE_URL` | Empty in dev (use Vite proxy). Absolute CP origin in production builds if not same-origin. |
| `VITE_AUTH_MODE` | `apikey` (CI/local) or `oidc` (Clerk PKCE — production). |
| `VITE_OIDC_ISSUER_URL` / `VITE_OIDC_CLIENT_ID` | Required when `oidc`. |
| `VITE_DEV_PROXY_TARGET` | Default `http://127.0.0.1:3000`. |

## Production

```bash
cd dashboard && npm ci && npm run build
# Serve via control plane:
DASHBOARD_DIST_PATH=/absolute/path/to/dashboard/dist npm start  # in control-plane
```

Default resolve: `control-plane` looks for `../dashboard/dist` relative to cwd when `DASHBOARD_DIST_PATH` is unset.

## Auth

- **apikey:** paste a `vrl_` key; stored in `sessionStorage`; sent as `Authorization: Bearer`.
- **oidc:** Authorization Code + PKCE against Clerk generic OIDC (no Clerk session SDK).
- Active tenant: `X-Tenant-Id` on all API calls (selector in shell).
