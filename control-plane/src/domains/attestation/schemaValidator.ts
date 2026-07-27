export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export function validateSchema(
  type: string,
  schemaVersion: string,
  facts: Record<string, unknown>,
): void {
  if (type !== 'behavioral') {
    throw new SchemaValidationError(`Unknown attestation type: ${type}`);
  }

  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new SchemaValidationError('facts must be an object');
  }

  if (schemaVersion === '0') {
    return;
  }

  if (schemaVersion === '1') {
    if (Object.keys(facts).length === 0) {
      throw new SchemaValidationError('facts must contain at least one key');
    }
    for (const [key, value] of Object.entries(facts)) {
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new SchemaValidationError(
          `facts.${key} must be a primitive (string|number|boolean), got ${typeof value}`,
        );
      }
    }
    return;
  }

  throw new SchemaValidationError(`Unknown schema version: ${schemaVersion}`);
}