import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '../auth/AuthProvider';
import { config } from '../config';

/**
 * OIDC callback stub: exchanges ?code= for tokens once CP token endpoint / Clerk
 * token URL is wired. PR A stores nothing unless a bearer is already present.
 */
export function AuthCallbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState('Completing sign-in…');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error_description') || params.get('error');
    if (err) {
      setMessage(err);
      return;
    }
    const state = params.get('state');
    const expected = sessionStorage.getItem('verilink.oidc.state');
    if (!state || !expected || state !== expected) {
      setMessage('Invalid OIDC state');
      return;
    }
    if (!config.oidcIssuerUrl || !config.oidcClientId) {
      setMessage('OIDC is not configured');
      return;
    }
    // Token exchange is deferred until issuer token endpoint + redirect allowlist
    // are confirmed in deploy config. Keep the user on this page with guidance.
    setMessage(
      'Authorization code received. Token exchange will be enabled once Clerk OIDC token endpoint is configured for this deploy.'
    );
    if (auth.isAuthenticated) {
      navigate({ to: '/provider' });
    }
  }, [auth.isAuthenticated, navigate]);

  return (
    <div className="login">
      <h1 className="login__brand">VeriLink</h1>
      <p className="login__lede">{message}</p>
    </div>
  );
}
