export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

function isV0AllowedForIssuer(issuerId: string): boolean {
  const allowlist = (process.env.BEHAVIORAL_V0_ALLOWLIST || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) return true;
  return allowlist.includes(issuerId);
}

function isV0CutoffPassed(): boolean {
  const cutoff = process.env.BEHAVIORAL_V0_CUTOFF;
  if (!cutoff) return false;
  const cutoffTime = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffTime)) return false;
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

function validatePrimitiveFacts(facts: Record<string, unknown>): void {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new SchemaValidationError('facts must be an object');
  }
  if (Object.keys(facts).length === 0) {
    throw new SchemaValidationError('facts must contain at least one key');
  }
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new SchemaValidationError(
        `facts.${key} must be a primitive (string|number|boolean), got ${typeof value}`,
      );
    }
  }
}

function validateTransactionSummary(facts: Record<string, unknown>): void {
  const required = ['start', 'end', 'success_count', 'failure_count', 'dispute_count'];
  for (const field of required) {
    if (!(field in facts)) {
      throw new SchemaValidationError(`transaction_summary@1 missing required field: ${field}`);
    }
  }
  for (const field of ['success_count', 'failure_count', 'dispute_count']) {
    if (typeof facts[field] !== 'number') {
      throw new SchemaValidationError(`transaction_summary@1.${field} must be a number`);
    }
  }
}

function validateKyb(facts: Record<string, unknown>): void {
  const required = ['status', 'verifier', 'jurisdiction', 'verification_timestamp', 'expiry_timestamp'];
  for (const field of required) {
    if (!(field in facts)) {
      throw new SchemaValidationError(`kyb@1 missing required field: ${field}`);
    }
  }
}

function validateSecurityAudit(facts: Record<string, unknown>): void {
  const required = ['standard', 'result', 'auditor', 'report_digest', 'audit_timestamp'];
  for (const field of required) {
    if (!(field in facts)) {
      throw new SchemaValidationError(`security_audit@1 missing required field: ${field}`);
    }
  }
}

function validateNegativeIncident(facts: Record<string, unknown>): void {
  const required = ['category', 'severity', 'occurrence_timestamp', 'evidence_digest'];
  for (const field of required) {
    if (!(field in facts)) {
      throw new SchemaValidationError(`negative_incident@1 missing required field: ${field}`);
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

  if (schemaVersion === '0') {
    if (type !== 'behavioral') {
      throw new SchemaValidationError(`schema_version 0 is only allowed for behavioral, got ${type}`);
    }
    if (issuerId && !isV0AllowedForIssuer(issuerId)) {
      throw new SchemaValidationError(`behavioral@0 is only allowed for allowlisted legacy issuers`);
    }
    if (isV0CutoffPassed()) {
      throw new SchemaValidationError(`behavioral@0 is no longer accepted (cutoff passed)`);
    }
    return;
  }

  // schema_version '1' — full validation per type
  switch (type) {
    case 'behavioral':
      validatePrimitiveFacts(facts);
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