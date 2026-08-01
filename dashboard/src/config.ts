export type AuthMode = 'apikey' | 'oidc';

export const config = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, ''),
  authMode: (import.meta.env.VITE_AUTH_MODE === 'oidc' ? 'oidc' : 'apikey') as AuthMode,
  oidcIssuerUrl: import.meta.env.VITE_OIDC_ISSUER_URL ?? '',
  oidcClientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? '',
} as const;
