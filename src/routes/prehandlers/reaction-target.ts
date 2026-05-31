import { FastifyRequest } from 'fastify';
import { InvalidReactionTargetTypeError } from '../../services/issue/errors';
import type { ReactionTargetType } from '../../services/issue/utils';

interface ReactionTargetPrehandlerOptions {
  param?: string;
}

export function requireReactionTargetTypePrehandler(
  options: ReactionTargetPrehandlerOptions = {}
) {
  const paramName = options.param ?? 'type';

  return async (request: FastifyRequest) => {
    const raw = (request.params as Record<string, string>)[paramName];
    if (raw !== 'issue' && raw !== 'comment') {
      throw new InvalidReactionTargetTypeError();
    }
    request.resolvedReactionTargetType = raw;
  };
}
