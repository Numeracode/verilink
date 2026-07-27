// control-plane/src/shared/logger.ts
import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.server.logLevel,
  base: { service: 'verilink-control-plane' },
  redact: {
    paths: ['req.headers.authorization', 'password', 'token', 'secret', 'apiKey', 'key_hash_hmac'],
    censor: '[REDACTED]',
  },
});