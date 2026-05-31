import { FastifyRequest } from 'fastify';
import { getDatabase } from '../../db/database';
import { getProjectRequestContext } from '../../middleware/request-context';
import {
  requireAgentAccess,
  requireIssueAccess,
  requireCommentAccess,
  requireMilestoneAccess,
  requireKnowledgeAccess,
  requireMessageAccess,
  requireRelationAccess,
} from '../../services/project-access';

type EntityType =
  | 'agent'
  | 'issue'
  | 'comment'
  | 'milestone'
  | 'knowledge'
  | 'message'
  | 'relation';

interface EntityAccessPrehandlerOptions {
  param?: string;
  manage?: boolean;
}

const ENTITY_ACCESS_MAP: Record<EntityType, (db: any, ctx: any, id: string, manage: boolean) => any> = {
  agent: requireAgentAccess,
  issue: requireIssueAccess,
  comment: requireCommentAccess,
  milestone: requireMilestoneAccess,
  knowledge: requireKnowledgeAccess,
  message: requireMessageAccess,
  relation: requireRelationAccess,
};

export function requireEntityAccessPrehandler(
  entity: EntityType,
  options: EntityAccessPrehandlerOptions = {}
) {
  const paramName = options.param ?? 'id';
  const manage = options.manage ?? false;
  const accessFn = ENTITY_ACCESS_MAP[entity];

  return async (request: FastifyRequest) => {
    const entityId = (request.params as Record<string, string>)[paramName];
    const db = getDatabase();
    const result = accessFn(
      db,
      getProjectRequestContext(request),
      entityId,
      manage
    );
    request.projectPermission = result.permission;
    request.resolvedEntity = result.entity;
  };
}
