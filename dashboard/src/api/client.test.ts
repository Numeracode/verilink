import { describe, it, expect, beforeEach } from 'vitest';
import { ApiError, apiFetch } from '../api/client';
import { setStoredTenantId, setStoredToken } from '../auth/session';
import { createPkcePair, buildAuthorizeUrl, discoverOidc } from '../auth/oidc';

describe('apiFetch', () => {
  beforeEach(() => {
    setStoredToken(null);
    setStoredTenantId(null);
  });

  it('attaches Authorization and X-Tenant-Id', async () => {
    setStoredToken('vrl_test');
    setStoredTenantId('11111111-1111-1111-1111-111111111111');

    const calls: Array<{ url: string; headers: Headers }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const body = await apiFetch<{ ok: boolean }>('/v1/health-proxy');
      expect(body.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.get('Authorization')).toBe('Bearer vrl_test');
      expect(calls[0].headers.get('X-Tenant-Id')).toBe('11111111-1111-1111-1111-111111111111');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws ApiError on non-2xx', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 403 });
    try {
      await expect(apiFetch('/v1/x')).rejects.toBeInstanceOf(ApiError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sets Content-Type only for string bodies', async () => {
    const calls: Headers[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push(new Headers(init?.headers));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      await apiFetch('/v1/a', { method: 'POST', body: JSON.stringify({ x: 1 }) });
      expect(calls[0].get('Content-Type')).toBe('application/json');
      calls.length = 0;
      await apiFetch('/v1/b', { method: 'POST', body: new Blob(['x']) });
      expect(calls[0].has('Content-Type')).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('oidc pkce', () => {
  it('creates verifier and S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThan(20);
    expect(pair.challenge.length).toBeGreaterThan(20);
    expect(pair.challenge).not.toContain('+');
  });

  it('buildAuthorizeUrl uses discovery authorization endpoint', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: 'https://example.com/oauth/authorize',
      clientId: 'client',
      redirectUri: 'http://localhost/auth/callback',
      state: 'st',
      codeChallenge: 'ch',
    });
    expect(url).toContain('https://example.com/oauth/authorize?');
    expect(url).toContain('code_challenge=ch');
  });

  it('discoverOidc reads well-known document', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: 'https://idp.example/authorize',
          token_endpoint: 'https://idp.example/token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    try {
      const d = await discoverOidc('https://idp.example');
      expect(d.authorization_endpoint).toBe('https://idp.example/authorize');
      expect(d.token_endpoint).toBe('https://idp.example/token');
    } finally {
      globalThis.fetch = original;
    }
  });
});
