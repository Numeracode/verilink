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
  if (json.length > MAX_FACTS_BYTES) {
    throw new SchemaValidationError(`facts exceed 8 KB limit (${json.length} bytes)`);
  }
  if (depth > MAX_DEPTH) {
    throw new SchemaValidationError(`facts exceed max depth ${MAX_DEPTH}`);
  }
  if (facts && typeof facts === 'object' && !Array.isArray(facts)) {
    for (const v of Object.values(facts)) {
      if (v && typeof v === 'object') {
        checkSizeAndDepth(v, depth + 1);
      }
    }
  }
}

function requireFields(facts: Record<string, unknown>, required: string[], type: string): void {
  for (const field of required) {
    if (!(field in facts)) {
      throw new SchemaValidationError(`${type}@1 missing required field: ${field}`);
    }
  }
}

function requireString(facts: Record<string, unknown>, field: string, type: string): void {
  const v = facts[field];
  if (v !== undefined && v !== null && typeof v !== 'string') {
    throw new SchemaValidationError(`${type}@1.${field} must be a string, got ${typeof v}`);
  }
}

function requireNumber(facts: Record<string, unknown>, field: string, type: string): void {
  const v = facts[field];
  if (v !== undefined && v !== null && typeof v !== 'number') {
    throw new SchemaValidationError(`${type}@1.${field} must be a number, got ${typeof v}`);
  }
}

function validateTransactionSummary(facts: Record<string, unknown>): void {
  const required = ['start', 'end', 'success_count', 'failure_count', 'dispute_count'];
  requireFields(facts, required, 'transaction_summary');
  requireString(facts, 'start', 'transaction_summary');
  requireString(facts, 'end', 'transaction_summary');
  requireNumber(facts, 'success_count', 'transaction_summary');
  requireNumber(facts, 'failure_count', 'transaction_summary');
  requireNumber(facts, 'dispute_count', 'transaction_summary');
}

function validateKyb(facts: Record<string, unknown>): void {
  const required = ['status', 'verifier', 'jurisdiction', 'verification_timestamp', 'expiry_timestamp'];
  requireFields(facts, required, 'kyb');
  for (const f of required) requireString(facts, f, 'kyb');
}

function validateSecurityAudit(facts: Record<string, unknown>): void {
  const required = ['standard', 'result', 'auditor', 'report_digest', 'audit_timestamp'];
  requireFields(facts, required, 'security_audit');
  for (const f of required) requireString(facts, f, 'security_audit');
}

function validateNegativeIncident(facts: Record<string, unknown>): void {
  const required = ['category', 'severity', 'occurrence_timestamp', 'evidence_digest'];
  requireFields(facts, required, 'negative_incident');
  for (const f of required) requireString(facts, f, 'negative_incident');
}

function validateBehavioralV1(facts: Record<string, unknown>): void {
  if (Object.keys(facts).length === 0) {
    throw new SchemaValidationError('behavioral@1: facts must contain at least one key');
  }
  if (!('observation_ts' in facts)) {
    throw new SchemaValidationError('behavioral@1: missing required field: observation_ts');
  }
  requireString(facts, 'observation_ts', 'behavioral');
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'observation_ts') continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new SchemaValidationError(
        `behavioral@1.${key} must be a primitive (string|number|boolean), got ${typeof value}`,
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