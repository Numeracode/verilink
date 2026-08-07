/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_MODE?: 'apikey' | 'oidc';
  readonly VITE_OIDC_ISSUER_URL?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
  readonly VITE_DEV_PROXY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
