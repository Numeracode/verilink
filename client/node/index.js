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

const crypto = require('crypto');
const { createPrivateKey, sign: nodeCryptoSign, verify: nodeCryptoVerify } = crypto;
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

// ── RFC 9421 HTTP Message Signatures ──────────────────────────────────────────

/**
 * Compute a content-digest header value per draft-ietf-httpbis-content-digest.
 * @param {Buffer|string|null} body
 * @returns {string} e.g. "sha-256=:abc123=:"
 */
function computeContentDigest(body) {
  const buf = body == null ? Buffer.alloc(0) : (typeof body === 'string' ? Buffer.from(body) : body);
  const hash = crypto.createHash('sha256').update(buf).digest();
  return `sha-256=:${b64url(hash)}:`;
}

/**
 * Build the RFC 9421 signature base string.
 * @param {object} opts
 * @param {string}  opts.method    HTTP method (GET, POST, etc.)
 * @param {string}  opts.targetURI Full target URI
 * @param {number}  opts.created   Unix timestamp
 * @param {number}  opts.expires   Unix timestamp
 * @param {Buffer|string|null} [opts.body]
 * @returns {string}
 */
function buildSignatureBase({ method, targetURI, created, expires, body }) {
  const bodyLen = body == null ? 0 : Buffer.byteLength(body);
  const lines = [
    `"@method": ${method.toUpperCase()}`,
    `"@target-uri": ${targetURI}`,
    `"@created": ${created}`,
    `"@expires": ${expires}`,
  ];
  if (bodyLen > 0) {
    lines.push(`"content-digest": ${computeContentDigest(body)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Sign an outgoing HTTP request with RFC 9421.
 * @param {object} req          Request-like object (url, method, headers)
 * @param {string} privKeyHex   128-char hex Ed25519 private key
 * @param {string} keyLabel     Label for this key
 * @param {string} issuerDID    Issuer DID
 * @returns {{ signatureBase: string, sigInput: string, signature: string }}
 */
function signRequest(req, privKeyHexOrObj, keyLabel, issuerDID) {
  const privKeyObj = typeof privKeyHexOrObj === 'string'
    ? importPrivKey(privKeyHexOrObj)
    : privKeyHexOrObj;
  const keyid = `vrl:agent:${issuerDID}|${keyLabel}`;

  const body = req.body || null;
  const bodyLen = body == null ? 0 : Buffer.byteLength(body);
  const method = (req.method || 'GET').toUpperCase();
  const targetURI = req.url;

  const now = Math.floor(Date.now() / 1000);
  const created = req.created || now;
  const expires = req.expires || now + 300;
  const nonce = crypto.randomUUID().replace(/-/g, '');

  const sigBase = buildSignatureBase({ method, targetURI, created, expires, body });

  const sigBytes = nodeCryptoSign(null, Buffer.from(sigBase), privKeyObj);

  const components = ['"@method"', '"@target-uri"', '"@created"', '"@expires"'];
  if (bodyLen > 0) components.push('"content-digest"');

  const sigInput = `${components.join(' ')};keyid="${keyid}";created=${created};expires=${expires};nonce=${nonce}`;
  const signature = b64url(sigBytes);

  return { signatureBase: sigBase, sigInput, signature };
}

/**
 * Verify an RFC 9421 signature on a received request.
 * @param {string}   sigInputHeader  Value of Signature-Input header
 * @param {string}   sigHeader       Value of Signature header
 * @param {string}   method          HTTP method
 * @param {string}   targetURI       Target URI
 * @param {Function} getBody         () => Buffer|string|null
 * @param {Function} lookupKey       (keyid) => crypto.KeyObject (public key)
 * @returns {{ valid: boolean, keyid: string, reason?: string }}
 */
function verifySignatureInput(sigInputHeader, sigHeader, method, targetURI, getBody, lookupKey) {
  try {
    if (!sigInputHeader || !sigInputHeader.trim()) {
      return { valid: false, keyid: '', reason: 'empty signature-input header' };
    }

    const parts = sigInputHeader.split(';');
    const componentsStr = parts[0].trim();
    if (!componentsStr) {
      return { valid: false, keyid: '', reason: 'missing covered-component list' };
    }

    const params = {};
    for (const part of parts.slice(1)) {
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) continue;
      const k = part.slice(0, eqIdx).trim();
      const v = part.slice(eqIdx + 1).trim().replace(/^"|"$/g, '');
      params[k] = v;
    }

    const keyid = params.keyid;
    if (!keyid) {
      return { valid: false, keyid: '', reason: 'missing keyid' };
    }

    const created = Number(params.created);
    const expires = Number(params.expires);
    const nonce = params.nonce || '';

    const now = Math.floor(Date.now() / 1000);
    const maxSkew = 30;
    if (created && now < created - maxSkew) {
      return { valid: false, keyid, reason: `signature created in the future: created=${created} now=${now}` };
    }
    if (expires && now > expires + maxSkew) {
      return { valid: false, keyid, reason: `signature expired: expires=${expires} now=${now}` };
    }
    if (created && expires && expires - created > 300) {
      return { valid: false, keyid, reason: `validity window exceeds 300 seconds` };
    }
    if (!nonce) {
      return { valid: false, keyid, reason: 'missing nonce in signature-input' };
    }

    const body = getBody();
    const sigBase = buildSignatureBase({ method, targetURI, created, expires, body });

    const pubKeyObj = lookupKey(keyid);
    if (!pubKeyObj) {
      return { valid: false, keyid, reason: `unknown keyid: ${keyid}` };
    }

    const sigBytes = Buffer.from(sigHeader, 'base64url');
    const valid = nodeCryptoVerify(null, Buffer.from(sigBase), pubKeyObj, sigBytes);
    return { valid, keyid };
  } catch (err) {
    return { valid: false, keyid: '', reason: err.message };
  }
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

  /**
   * Sign an outgoing request object with RFC 9421.
   * Mutates req.headers with Signature-Input and Signature.
   *
   * @param {object} req              Request-like object with url, method, headers
   * @param {string} [keyLabel='default']  Label for the signing key
   * @returns {{ signatureBase: string, sigInput: string, signature: string }}
   */
  signRequest(req, keyLabel = 'default') {
    const result = signRequest(req, this._privKey, keyLabel, this._issuer);
    req.headers = req.headers || {};
    req.headers['Signature-Input'] = result.sigInput;
    req.headers['Signature'] = result.signature;
    return result;
  }
}

module.exports = {
  VeriLinkClient,
  computeContentDigest,
  buildSignatureBase,
  signRequest,
  verifySignatureInput,
};
