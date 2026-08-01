/**
 * Dashboard SPA static mount (no DB required).
 */
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-unit';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';

describe('dashboard SPA serve', () => {
  let distDir: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    distDir = await mkdtemp(path.join(tmpdir(), 'verilink-dash-'));
    await writeFile(
      path.join(distDir, 'index.html'),
      '<!doctype html><html><body><div id="root">VeriLink SPA</div></body></html>\n',
      'utf8'
    );
    await writeFile(path.join(distDir, 'asset.txt'), 'static-ok\n', 'utf8');
    process.env.DASHBOARD_DIST_PATH = distDir;

    const { createApp } = await import('../app.js');
    const app: Express = createApp();
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(distDir, { recursive: true, force: true });
    delete process.env.DASHBOARD_DIST_PATH;
  });

  it('serves index.html for SPA paths', async () => {
    const res = await fetch(`${baseUrl}/provider`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /VeriLink SPA/);
  });

  it('serves static assets from dist', async () => {
    const res = await fetch(`${baseUrl}/asset.txt`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), 'static-ok');
  });

  it('keeps /healthz as JSON', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('keeps unknown /v1 routes as API 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/does-not-exist`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok?: boolean };
    assert.notEqual(body.ok, true);
  });
});
