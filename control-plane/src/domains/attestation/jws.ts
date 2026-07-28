// control-plane/src/domains/attestation/jws.ts
export interface JWSHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface JWSPayload {
  iss?: string;
  sub?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  vli?: {
    type?: string;
    facts?: Record<string, unknown>;
    trust_level_delta?: number;
    schema_version?: string;
    visibility?: string;
    observation_id?: string;
  };
  [key: string]: unknown;
}

export interface PreParsedJWS {
  header: JWSHeader;
  payload: JWSPayload;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export function preParseJWS(token: string): PreParsedJWS {
  if (typeof token !== 'string') throw new Error('jws: token must be a string');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jws: expected 3 compact serialization parts');

  if (!BASE64URL_RE.test(parts[0]) || !BASE64URL_RE.test(parts[1])) {
    throw new Error('jws: invalid base64url encoding');
  }

  let headerJson: string;
  let payloadJson: string;
  try {
    headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch (err) {
    throw new Error('jws: invalid base64url encoding');
  }

  let header: JWSHeader;
  let payload: JWSPayload;
  try {
    header = JSON.parse(headerJson);
    payload = JSON.parse(payloadJson);
  } catch (err) {
    throw new Error('jws: invalid JSON in header or payload');
  }

  if (!header || typeof header !== 'object') throw new Error('jws: header must be an object');
  if (!payload || typeof payload !== 'object') throw new Error('jws: payload must be an object');
  if (!header.alg || typeof header.alg !== 'string') throw new Error('jws: header.alg is required');

  return { header, payload };
}