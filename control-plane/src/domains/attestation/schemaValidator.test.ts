import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateSchema, SchemaValidationError } from './schemaValidator.js';

describe('validateSchema', () => {
  it('behavioral@0 accepts any object', () => {
    assert.doesNotThrow(() => validateSchema('behavioral', '0', { action: 'test' }));
  });

  it('behavioral@0 accepts empty object', () => {
    assert.doesNotThrow(() => validateSchema('behavioral', '0', {}));
  });

  it('behavioral@1 accepts valid facts', () => {
    assert.doesNotThrow(() =>
      validateSchema('behavioral', '1', { action: 'commit', count: 5 }),
    );
  });

  it('behavioral@1 rejects empty facts', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', {}),
      SchemaValidationError,
    );
  });

  it('behavioral@1 rejects nested objects', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', { nested: { a: 1 } }),
      SchemaValidationError,
    );
  });

  it('behavioral@1 rejects arrays', () => {
    assert.throws(
      () => validateSchema('behavioral', '1', { items: [1, 2] }),
      SchemaValidationError,
    );
  });

  it('unknown type rejects', () => {
    assert.throws(
      () => validateSchema('unknown', '1', { a: 1 }),
      SchemaValidationError,
    );
  });

  it('unknown schema version rejects', () => {
    assert.throws(
      () => validateSchema('behavioral', '2', { a: 1 }),
      SchemaValidationError,
    );
  });
});