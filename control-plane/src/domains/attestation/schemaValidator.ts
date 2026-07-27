export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export class SchemaValidationExpiredError extends SchemaValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationExpiredError';
  }
}

function isV0AllowedForIssuer(issuerId: string): boolean {
  const allowlist = (process.env.BEHAVIORAL_V0_ALLOWLIST || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) return false;
  return allowlist.includes(issuerId);
}

function isV0CutoffPassed(): boolean {
  const cutoff = process.env.BEHAVIORAL_V0_CUTOFF;
  if (!cutoff) return true;
  const cutoffTime = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffTime)) return true;
  return Date.now() > cutoffTime;
}

const SUPPORTED_TYPES = new Set([
  'behavioral',
  'transaction_summary',
  'kyb',
  'security_audit',
  'negative_incident',
]);

const SUPPORTED_VERSIONS = new Set(['0', '1']);

const MAX_FACTS_BYTES = 8192;
const MAX_DEPTH = 4;

function checkSizeAndDepth(facts: unknown, depth = 0): void {
  const json = JSON.stringify(facts);
  if (Buffer.byteLength(json, 'utf8') > MAX_FACTS_BYTES) {
    throw new SchemaValidationError(
      `facts exceed ${MAX_FACTS_BYTES} byte limit (${Buffer.byteLength(json, 'utf8')} bytes)`,
    );
  }
  if (depth > MAX_DEPTH) {
    throw new SchemaValidationError(`facts exceed max depth ${MAX_DEPTH}`);
  }
  if (facts && typeof facts === 'object') {
    const iter = Array.isArray(facts) ? facts : Object.values(facts as Record<string, unknown>);
    for (const v of iter) {
      if (v && typeof v === 'object') {
        checkSizeAndDepth(v, depth + 1);
      }
    }
  }
}

function requireFields(facts: Record<string, unknown>, required: string[], type: string): void {
  for (const field of required) {
    if (!(field in facts) || facts[field] === undefined || facts[field] === null) {
      throw new SchemaValidationError(`${type}@1 missing or null required field: ${field}`);
    }
  }
}

function requireString(facts: Record<string, unknown>, field: string, type: string): void {
  const v = facts[field];
  if (v === undefined || v === null) {
    throw new SchemaValidationError(`${type}@1.${field} is required and must be a non-null string`);
  }
  if (typeof v !== 'string') {
    throw new SchemaValidationError(`${type}@1.${field} must be a string, got ${typeof v}`);
  }
}

function requireNumber(facts: Record<string, unknown>, field: string, type: string): void {
  const v = facts[field];
  if (v === undefined || v === null) {
    throw new SchemaValidationError(`${type}@1.${field} is required and must be a non-null number`);
  }
  if (typeof v !== 'number') {
    throw new SchemaValidationError(`${type}@1.${field} must be a number, got ${typeof v}`);
  }
}

function rejectExtraProperties(
  facts: Record<string, unknown>,
  allowed: Set<string>,
  type: string,
): void {
  for (const key of Object.keys(facts)) {
    if (!allowed.has(key)) {
      throw new SchemaValidationError(
        `${type}@1: unknown property "${key}" (additionalProperties: false)`,
      );
    }
  }
}

const TS_FIELDS = new Set(['start', 'end', 'success_count', 'failure_count', 'dispute_count']);
function validateTransactionSummary(facts: Record<string, unknown>): void {
  requireFields(facts, [...TS_FIELDS], 'transaction_summary');
  requireString(facts, 'start', 'transaction_summary');
  requireString(facts, 'end', 'transaction_summary');
  requireNumber(facts, 'success_count', 'transaction_summary');
  requireNumber(facts, 'failure_count', 'transaction_summary');
  requireNumber(facts, 'dispute_count', 'transaction_summary');
  rejectExtraProperties(facts, TS_FIELDS, 'transaction_summary');
}

const KYB_FIELDS = new Set(['status', 'verifier', 'jurisdiction', 'verification_timestamp', 'expiry_timestamp']);
function validateKyb(facts: Record<string, unknown>): void {
  requireFields(facts, [...KYB_FIELDS], 'kyb');
  for (const f of KYB_FIELDS) requireString(facts, f, 'kyb');
  rejectExtraProperties(facts, KYB_FIELDS, 'kyb');
}

const AUDIT_FIELDS = new Set(['standard', 'result', 'auditor', 'report_digest', 'audit_timestamp']);
function validateSecurityAudit(facts: Record<string, unknown>): void {
  requireFields(facts, [...AUDIT_FIELDS], 'security_audit');
  for (const f of AUDIT_FIELDS) requireString(facts, f, 'security_audit');
  rejectExtraProperties(facts, AUDIT_FIELDS, 'security_audit');
}

const INCIDENT_FIELDS = new Set(['category', 'severity', 'occurrence_timestamp', 'evidence_digest']);
function validateNegativeIncident(facts: Record<string, unknown>): void {
  requireFields(facts, [...INCIDENT_FIELDS], 'negative_incident');
  for (const f of INCIDENT_FIELDS) requireString(facts, f, 'negative_incident');
  rejectExtraProperties(facts, INCIDENT_FIELDS, 'negative_incident');
}

const MAX_DATA_BYTES = 4096;

function validateBehavioralV1(facts: Record<string, unknown>): void {
  if (Object.keys(facts).length === 0) {
    throw new SchemaValidationError('behavioral@1: facts must contain at least one key');
  }
  requireString(facts, 'observation_ts', 'behavioral');
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'observation_ts') continue;
    if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
      const dataJson = JSON.stringify(value);
      const dataBytes = Buffer.byteLength(dataJson, 'utf8');
      if (dataBytes > MAX_DATA_BYTES) {
        throw new SchemaValidationError(
          `behavioral@1.data exceeds ${MAX_DATA_BYTES} byte limit (${dataBytes} bytes)`,
        );
      }
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new SchemaValidationError(
        `behavioral@1.${key} must be a primitive or a "data" object, got ${typeof value}`,
      );
    }
  }
}

export function validateSchema(
  type: string,
  schemaVersion: string,
  facts: Record<string, unknown>,
  issuerId?: string,
): void {
  if (!SUPPORTED_TYPES.has(type)) {
    throw new SchemaValidationError(`Unknown attestation type: ${type}`);
  }
  if (!SUPPORTED_VERSIONS.has(schemaVersion)) {
    throw new SchemaValidationError(`Unknown schema version: ${schemaVersion}`);
  }

  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new SchemaValidationError('facts must be an object');
  }

  checkSizeAndDepth(facts);

  if (schemaVersion === '0') {
    if (type !== 'behavioral') {
      throw new SchemaValidationError(`schema_version 0 is only allowed for behavioral, got ${type}`);
    }
    if (!issuerId || !isV0AllowedForIssuer(issuerId)) {
      throw new SchemaValidationError(`behavioral@0 is only allowed for allowlisted legacy issuers`);
    }
    if (isV0CutoffPassed()) {
      throw new SchemaValidationExpiredError(`behavioral@0 is no longer accepted (cutoff passed)`);
    }
    return;
  }

  // schema_version '1' — full validation per type
  switch (type) {
    case 'behavioral':
      validateBehavioralV1(facts);
      break;
    case 'transaction_summary':
      validateTransactionSummary(facts);
      break;
    case 'kyb':
      validateKyb(facts);
      break;
    case 'security_audit':
      validateSecurityAudit(facts);
      break;
    case 'negative_incident':
      validateNegativeIncident(facts);
      break;
    default:
      throw new SchemaValidationError(`Unsupported attestation type: ${type}`);
  }
}