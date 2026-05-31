import { FastifyRequest } from 'fastify';

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputValidationError';
  }
}

export interface FieldRule {
  field: string;
  rule: 'required' | 'enum' | 'json' | 'url';
  message?: string;
  enumValues?: readonly string[];
  urlProtocols?: string[];
}

export interface InputValidationOptions {
  body?: FieldRule[];
  query?: FieldRule[];
}

function validateField(value: unknown, rule: FieldRule): string | null {
  switch (rule.rule) {
    case 'required': {
      const str = String(value ?? '').trim();
      if (!str) return rule.message ?? `${rule.field} is required`;
      return null;
    }
    case 'enum': {
      const str = String(value ?? '').trim();
      if (!str) return rule.message ?? `${rule.field} is required`;
      const allowed = rule.enumValues ?? [];
      if (!allowed.includes(str)) {
        return rule.message ?? `${rule.field} must be one of: ${allowed.join(', ')}`;
      }
      return null;
    }
    case 'json': {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value === 'string') {
        try { JSON.parse(value); } catch {
          return rule.message ?? `${rule.field} must be valid JSON`;
        }
      }
      return null;
    }
    case 'url': {
      const str = String(value ?? '').trim();
      if (!str) return rule.message ?? `${rule.field} is required`;
      try {
        const url = new URL(str);
        const protocols = rule.urlProtocols ?? ['http:', 'https:'];
        if (!protocols.includes(url.protocol)) {
          return rule.message ?? `${rule.field} must use ${protocols.join(' or ')}`;
        }
      } catch {
        return rule.message ?? `${rule.field} must be a valid URL`;
      }
      return null;
    }
  }
}

export function validateInput(options: InputValidationOptions) {
  return async (request: FastifyRequest) => {
    if (options.body) {
      const body = request.body as Record<string, unknown> | undefined;
      for (const rule of options.body) {
        const error = validateField(body?.[rule.field], rule);
        if (error) throw new InputValidationError(error);
      }
    }

    if (options.query) {
      const query = request.query as Record<string, unknown>;
      for (const rule of options.query) {
        const error = validateField(query[rule.field], rule);
        if (error) throw new InputValidationError(error);
      }
    }
  };
}
