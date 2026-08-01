import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '../auth/AuthProvider';
import { config } from '../config';
import { buildAuthorizeUrl, createPkcePair } from '../auth/oidc';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onApiKeySubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const key = apiKey.trim();
    // Match control-plane authenticateApiKey: vrl_ + 64 hex = 68 chars.
    if (!/^vrl_[0-9a-f]{64}$/i.test(key)) {
      setError('API key must be vrl_ followed by 64 hex characters (68 total)');
      return;
    }
    auth.setToken(key);
    navigate({ to: '/provider' });
  }

  async function onOidcStart() {
    setError(null);
    if (!config.oidcIssuerUrl || !config.oidcClientId) {
      setError('OIDC is not configured (VITE_OIDC_ISSUER_URL / VITE_OIDC_CLIENT_ID)');
      return;
    }
    try {
      const { verifier, challenge } = await createPkcePair();
      const state = crypto.randomUUID();
      sessionStorage.setItem('verilink.oidc.verifier', verifier);
      sessionStorage.setItem('verilink.oidc.state', state);
      const redirectUri = `${window.location.origin}/auth/callback`;
      window.location.assign(
        buildAuthorizeUrl({
          issuerUrl: config.oidcIssuerUrl,
          clientId: config.oidcClientId,
          redirectUri,
          state,
          codeChallenge: challenge,
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OIDC start failed');
    }
  }

  return (
    <div className="login">
      <h1 className="login__brand">VeriLink</h1>
      <p className="login__lede">Sign in to the control-plane dashboard.</p>

      {auth.authMode === 'apikey' ? (
        <form className="login__form" onSubmit={onApiKeySubmit}>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="vrl_…"
            />
          </label>
          <button type="submit">Continue</button>
        </form>
      ) : (
        <button type="button" className="login__oidc" onClick={() => void onOidcStart()}>
          Sign in with Clerk (OIDC)
        </button>
      )}

      {error ? <p className="login__error">{error}</p> : null}
    </div>
  );
}
