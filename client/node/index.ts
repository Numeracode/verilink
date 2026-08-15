// client/node/index.ts
// VeriLink Node.js client — TypeScript, zero external dependencies.
// Uses Node's built-in crypto module (Ed25519 requires Node >= 15).

import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const { createPrivateKey, sign: nodeCryptoSign, verify: nodeCryptoVerify } = crypto;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VeriLinkClientOptions {
  attestationURL: string;
  issuerDID: string;
  privateKeyHex: string;
}

export interface SubmitAttestationOptions {
  type?: string;
  trustLevelDelta?: number;
}

export interface SignRequestResult {
  signatureBase: string;
  sigInput: string;
  signature: string;
}

export interface VerifyResult {
  valid: boolean;
  keyid: string;
  reason?: string;
}

export interface RequestLike {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  created?: number;
  expires?: number;
}

// ── JWT helpers (EdDSA, no external lib) ──────────────────────────────────────

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function importPrivKey(hexPriv: string): crypto.KeyObject {
  if (typeof hexPriv !== 'string' || hexPriv.length !== 128) {
    throw new Error(
      'VERILINK_ISSUER_PRIVATE_KEY must be 128 hex chars (64-byte Ed25519 key)',
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

function signJWT(payload: Record<string, unknown>, privKeyObj: crypto.KeyObject): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const msg = Buffer.from(`${header}.${body}`);
  const sig = nodeCryptoSign(null, msg, privKeyObj);
  return `${header}.${body}.${b64url(sig)}`;
}

// ── RFC 9421 HTTP Message Signatures ──────────────────────────────────────────

export function computeContentDigest(body: string | Buffer | null): string {
  const buf = body == null ? Buffer.alloc(0) : (typeof body === 'string' ? Buffer.from(body) : body);
  const hash = crypto.createHash('sha256').update(buf).digest();
  return `sha-256=:${b64url(hash)}:`;
}

interface SignatureBaseOpts {
  method: string;
  targetURI: string;
  created: number;
  expires: number;
  body?: string | Buffer | null;
  extra?: Array<{ name: string; value: string }>;
}

export function buildSignatureBase(opts: SignatureBaseOpts): string {
  const body = opts.body ?? null;
  const bodyLen = body == null ? 0 : Buffer.byteLength(body);
  const lines: string[] = [
    `"@method": ${opts.method.toUpperCase()}`,
    `"@target-uri": ${opts.targetURI}`,
    `"@created": ${opts.created}`,
    `"@expires": ${opts.expires}`,
  ];
  if (bodyLen > 0) {
    lines.push(`"content-digest": ${computeContentDigest(body)}`);
  }
  if (opts.extra) {
    for (const c of opts.extra) {
      lines.push(`"${c.name}": ${c.value}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function signRequest(
  req: RequestLike,
  privKeyHexOrObj: string | crypto.KeyObject,
  keyLabel: string,
  issuerDID: string,
  extra?: Array<{ name: string; value: string }>,
): SignRequestResult {
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

  const sigBase = buildSignatureBase({ method, targetURI, created, expires, body, extra });

  const sigBytes = nodeCryptoSign(null, Buffer.from(sigBase), privKeyObj);

  const components: string[] = ['"@method"', '"@target-uri"', '"@created"', '"@expires"'];
  if (bodyLen > 0) components.push('"content-digest"');
  if (extra) {
    for (const c of extra) {
      components.push(`"${c.name}"`);
    }
  }

  const sigInput = `${components.join(' ')};keyid="${keyid}";created=${created};expires=${expires};nonce=${nonce}`;
  const signature = b64url(sigBytes);

  return { signatureBase: sigBase, sigInput, signature };
}

export function signRequestWithIdempotencyKey(
  req: RequestLike,
  privKeyHexOrObj: string | crypto.KeyObject,
  keyLabel: string,
  issuerDID: string,
  idempotencyKey: string,
): SignRequestResult {
  req.headers = req.headers || {};
  req.headers['Idempotency-Key'] = idempotencyKey;
  const extra = [{ name: 'idempotency-key', value: idempotencyKey }];
  return signRequest(req, privKeyHexOrObj, keyLabel, issuerDID, extra);
}

export function verifySignatureInput(
  sigInputHeader: string,
  sigHeader: string,
  method: string,
  targetURI: string,
  getBody: () => string | Buffer | null,
  lookupKey: (keyid: string) => crypto.KeyObject | null,
  getExtraHeader?: (name: string) => string,
): VerifyResult {
  try {
    if (!sigInputHeader || !sigInputHeader.trim()) {
      return { valid: false, keyid: '', reason: 'empty signature-input header' };
    }

    const parts = sigInputHeader.split(';');
    const componentsStr = parts[0].trim();
    if (!componentsStr) {
      return { valid: false, keyid: '', reason: 'missing covered-component list' };
    }

    const params: Record<string, string> = {};
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

    // Parse extra components from the component list
    const derived = new Set(['@method', '@target-uri', '@created', '@expires', 'content-digest']);
    const componentList = componentsStr.match(/"[^"]+"/g) || [];
    const extra: Array<{ name: string; value: string }> = [];
    for (const comp of componentList) {
      const name = comp.replace(/"/g, '');
      if (!derived.has(name) && getExtraHeader) {
        extra.push({ name, value: getExtraHeader(name) });
      }
    }

    const sigBase = buildSignatureBase({ method, targetURI, created, expires, body, extra });

    const pubKeyObj = lookupKey(keyid);
    if (!pubKeyObj) {
      return { valid: false, keyid, reason: `unknown keyid: ${keyid}` };
    }

    const sigBytes = Buffer.from(sigHeader, 'base64url');
    const valid = nodeCryptoVerify(null, Buffer.from(sigBase), pubKeyObj, sigBytes);
    return { valid, keyid };
  } catch (err) {
    return { valid: false, keyid: '', reason: (err as Error).message };
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method: string, urlStr: string, bodyObj?: Record<string, unknown> | null): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const transport = u.protocol === 'https:' ? https : http;
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const opts: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      },
    };

    const req = transport.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            Object.assign(
              new Error(`VeriLink HTTP ${res.statusCode}: ${raw.trim()}`),
              { statusCode: res.statusCode },
            ),
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

export class VeriLinkClient {
  private _url: string;
  private _issuer: string;
  private _privKey: crypto.KeyObject;

  constructor(opts: VeriLinkClientOptions) {
    if (!opts.attestationURL) throw new Error('VeriLinkClient: attestationURL is required');
    if (!opts.issuerDID) throw new Error('VeriLinkClient: issuerDID is required');
    if (!opts.privateKeyHex) throw new Error('VeriLinkClient: privateKeyHex is required');

    this._url = opts.attestationURL.replace(/\/$/, '');
    this._issuer = opts.issuerDID;
    this._privKey = importPrivKey(opts.privateKeyHex);
  }

  static fromEnv(): VeriLinkClient {
    return new VeriLinkClient({
      attestationURL:
        process.env.VERILINK_ATTESTATION_URL || 'https://api.verilink.ai',
      issuerDID: process.env.VERILINK_ISSUER_DID!,
      privateKeyHex: process.env.VERILINK_ISSUER_PRIVATE_KEY!,
    });
  }

  async submitAttestation(
    subject: string,
    facts: Record<string, unknown> = {},
    opts: SubmitAttestationOptions = {},
  ): Promise<void> {
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

  async getTrustScore(fingerprint: string): Promise<number> {
    const data = await request(
      'GET',
      `${this._url}/v1/trust?fingerprint=${encodeURIComponent(fingerprint)}`,
    );
    return (data && typeof data.score === 'number') ? data.score : 0;
  }

  async isTrusted(fingerprint: string, threshold = 50): Promise<boolean> {
    const score = await this.getTrustScore(fingerprint);
    return score >= threshold;
  }

  signRequest(req: RequestLike, keyLabel = 'default'): SignRequestResult {
    const result = signRequest(req, this._privKey, keyLabel, this._issuer);
    req.headers = req.headers || {};
    req.headers['Signature-Input'] = result.sigInput;
    req.headers['Signature'] = result.signature;
    return result;
  }

  signRequestWithIdempotencyKey(req: RequestLike, keyLabel: string, idempotencyKey: string): SignRequestResult {
    const result = signRequestWithIdempotencyKey(req, this._privKey, keyLabel, this._issuer, idempotencyKey);
    req.headers = req.headers || {};
    req.headers['Signature-Input'] = result.sigInput;
    req.headers['Signature'] = result.signature;
    req.headers['Idempotency-Key'] = idempotencyKey;
    return result;
  }
}
