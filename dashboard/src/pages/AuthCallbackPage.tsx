import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '../auth/AuthProvider';
import { config } from '../config';
import { discoverOidc, exchangeAuthorizationCode } from '../auth/oidc';

function clearOidcTransient(): void {
  sessionStorage.removeItem('verilink.oidc.verifier');
  sessionStorage.removeItem('verilink.oidc.state');
}

/**
 * OIDC callback: validate state, exchange authorization code (PKCE), store bearer in memory.
 */
export function AuthCallbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState('Completing sign-in…');

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const params = new URLSearchParams(window.location.search);
      const err = params.get('error_description') || params.get('error');
      if (err) {
        clearOidcTransient();
        if (!cancelled) setMessage(err);
        return;
      }

      const state = params.get('state');
      const code = params.get('code');
      const expected = sessionStorage.getItem('verilink.oidc.state');
      const verifier = sessionStorage.getItem('verilink.oidc.verifier');
      if (!state || !expected || state !== expected) {
        clearOidcTransient();
        if (!cancelled) setMessage('Invalid OIDC state');
        return;
      }
      if (!code || !verifier) {
        clearOidcTransient();
        if (!cancelled) setMessage('Missing authorization code or PKCE verifier');
        return;
      }
      if (!config.oidcIssuerUrl || !config.oidcClientId) {
        clearOidcTransient();
        if (!cancelled) setMessage('OIDC is not configured');
        return;
      }

      try {
        const discovery = await discoverOidc(config.oidcIssuerUrl);
        const tokens = await exchangeAuthorizationCode({
          tokenEndpoint: discovery.token_endpoint,
          clientId: config.oidcClientId,
          code,
          redirectUri: `${window.location.origin}/auth/callback`,
          codeVerifier: verifier,
        });
        clearOidcTransient();
        if (cancelled) return;
        auth.setToken(tokens.access_token);
        navigate({ to: '/provider' });
      } catch (e) {
        clearOidcTransient();
        if (!cancelled) {
          setMessage(e instanceof Error ? e.message : 'OIDC token exchange failed');
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [auth, navigate]);

  return (
    <div className="login">
      <h1 className="login__brand">VeriLink</h1>
      <p className="login__lede">{message}</p>
    </div>
  );
}
