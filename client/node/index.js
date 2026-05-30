'use strict';

/**
 * VeriLink Node.js client — zero external dependencies.
 *
 * Uses Node's built-in `crypto` module (Ed25519 support requires Node ≥ 15).
 *
 * Usage (Whimsy):
 *   const { VeriLinkClient } = require('./client/node');
 *   const vl = VeriLinkClient.fromEnv();        // reads VERILINK_* env vars
 *   await vl.submitAttestation('did:key:whimsy-api', { action: 'file_scan' });
 *   const score = await vl.getTrustScore(fingerprint);
 */

const { createPrivateKey, sign: nodeCryptoSign } = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── JWT helpers (EdDSA, no external lib) ──────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Import a 64-byte Go-format Ed25519 private key (hex string).
 * Go's ed25519.PrivateKey = seed (32) + public key (32).
 * Node's JWK format needs `d` = seed, `x` = public key.
 */
function importPrivKey(hexPriv) {
  if (typeof hexPriv !== 'string' || hexPriv.length !== 128) {
    throw new Error(
      'VERILINK_ISSUER_PRIVATE_KEY must be 128 hex chars (64-byte Ed25519 key)'
    );
  }
  const raw = Buffer.from(hexPriv, 'hex');
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: raw.subarray(0, 32).toString('base64url'),
      x: raw.subarray(32).toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Create a signed EdDSA JWT (JWS Compact Serialisation).
 * Compatible with github.com/golang-jwt/jwt/v5 SigningMethodEdDSA.
 */
function signJWT(payload, privKeyObj) {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const msg = Buffer.from(`${header}.${body}`);
  const sig = nodeCryptoSign(null, msg, privKeyObj);
  return `${header}.${body}.${b64url(sig)}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method, urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const transport = u.protocol === 'https:' ? https : http;
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = transport.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(
            Object.assign(
              new Error(`VeriLink HTTP ${res.statusCode}: ${raw.trim()}`),
              { statusCode: res.statusCode }
            )
          );
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(raw);
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('VeriLink request timed out after 30s'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── VeriLinkClient ────────────────────────────────────────────────────────────

class VeriLinkClient {
  /**
   * @param {object} opts
   * @param {string}  opts.attestationURL  Base URL of the attestation service (e.g. http://localhost:8082)
   * @param {string}  opts.issuerDID       DID of the issuer (e.g. did:key:whimsy-system)
   * @param {string}  opts.privateKeyHex   128-char hex Ed25519 private key (from verilink-keygen)
   */
  constructor({ attestationURL, issuerDID, privateKeyHex }) {
    if (!attestationURL) throw new Error('VeriLinkClient: attestationURL is required');
    if (!issuerDID) throw new Error('VeriLinkClient: issuerDID is required');
    if (!privateKeyHex) throw new Error('VeriLinkClient: privateKeyHex is required');

    this._url = attestationURL.replace(/\/$/, '');
    this._issuer = issuerDID;
    this._privKey = importPrivKey(privateKeyHex);
  }

  /**
   * Build a VeriLinkClient from environment variables:
   *   VERILINK_ATTESTATION_URL  (default: http://localhost:8082)
   *   VERILINK_ISSUER_DID
   *   VERILINK_ISSUER_PRIVATE_KEY
   */
  static fromEnv() {
    return new VeriLinkClient({
      attestationURL:
        process.env.VERILINK_ATTESTATION_URL || 'http://localhost:8082',
      issuerDID: process.env.VERILINK_ISSUER_DID,
      privateKeyHex: process.env.VERILINK_ISSUER_PRIVATE_KEY,
    });
  }

  /**
   * Sign and submit a behavioural attestation.
   *
   * @param {string} subject      DID or identifier of the subject being attested
   * @param {object} facts        Arbitrary key/value behavioural facts
   * @param {object} [opts]
   * @param {string} [opts.type='behavioral']  Attestation type
   * @param {number} [opts.trustLevelDelta=10] Score delta to apply
   * @returns {Promise<void>}
   */
  async submitAttestation(subject, facts = {}, opts = {}) {
    const { type = 'behavioral', trustLevelDelta = 10 } = opts;

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this._issuer,
      sub: subject,
      iat: now,
      exp: now + 365 * 24 * 3600,
      vli: {
        type,
        facts,
        trust_level_delta: trustLevelDelta,
      },
    };

    const token = signJWT(payload, this._privKey);
    await request('POST', `${this._url}/v1/attestations/submit`, { token });
  }

  /**
   * Query the trust score for a fingerprint.
   *
   * @param {string} fingerprint  SHA-256 hex fingerprint
   * @returns {Promise<number>}   Score 0–100
   */
  async getTrustScore(fingerprint) {
    const data = await request(
      'GET',
      `${this._url}/v1/trust?fingerprint=${encodeURIComponent(fingerprint)}`
    );
    return (data && typeof data.score === 'number') ? data.score : 0;
  }

  /**
   * Check if a fingerprint meets the trust threshold.
   *
   * @param {string} fingerprint
   * @param {number} [threshold=50]
   * @returns {Promise<boolean>}
   */
  async isTrusted(fingerprint, threshold = 50) {
    const score = await this.getTrustScore(fingerprint);
    return score >= threshold;
  }
}

module.exports = { VeriLinkClient };
