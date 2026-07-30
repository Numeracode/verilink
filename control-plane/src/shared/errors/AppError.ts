// control-plane/src/shared/errors/AppError.ts

export const CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  GONE: 'GONE',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE: 'UNPROCESSABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
  UPSTREAM: 'UPSTREAM',
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

const STATUS_FOR: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GONE: 410,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
  UPSTREAM: 502,
};

export class AppError extends Error {
  code: ErrorCode;
  status: number;
  details?: unknown;
  cause?: Error;

  constructor(code: ErrorCode, message: string, opts?: { details?: unknown; cause?: Error }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_FOR[code];
    this.details = opts?.details;
    this.cause = opts?.cause;
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof Error) {
      return new AppError(CODES.INTERNAL, 'Internal server error', { cause: err });
    }
    return new AppError(CODES.INTERNAL, 'Internal server error');
  }

  toResponse() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}