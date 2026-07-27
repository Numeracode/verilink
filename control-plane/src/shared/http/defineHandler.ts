// control-plane/src/shared/http/defineHandler.ts
import type { Request, Response, NextFunction } from 'express';
import { AppError, CODES } from '../errors/AppError.js';

interface ParamDef {
  type?: 'string' | 'number' | 'boolean' | 'uuid';
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
}

interface HandlerConfig {
  params?: Record<string, ParamDef>;
  query?: Record<string, ParamDef>;
  fallbackMessage?: string;
  handler: (req: Request, res: Response) => Promise<unknown>;
}

function validateParam(value: unknown, name: string, def: ParamDef): void {
  if (value === undefined || value === null) {
    if (def.required !== false) {
      throw new AppError(CODES.BAD_REQUEST, `Missing required param: ${name}`);
    }
    return;
  }
  if (def.enum && !def.enum.includes(String(value))) {
    throw new AppError(CODES.BAD_REQUEST, `Invalid value for ${name}: ${value}`);
  }
}

export function defineHandler(config: HandlerConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate params
      if (config.params) {
        for (const [name, def] of Object.entries(config.params)) {
          validateParam(req.params[name], name, def);
        }
      }
      // Validate query
      if (config.query) {
        for (const [name, def] of Object.entries(config.query)) {
          validateParam(req.query[name], name, def);
        }
      }

      await config.handler(req, res);
    } catch (err) {
      next(err);
    }
  };
}