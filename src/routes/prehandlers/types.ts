import type { ProjectPermission } from '../../services/project-access';
import type { RemoteInstanceRecord } from '../../services/remote-instances';
import type { ReactionTargetType } from '../../services/issue/utils';

declare module 'fastify' {
  interface FastifyRequest {
    projectPermission?: ProjectPermission;
    resolvedEntity?: { id: string; project_id: string } & Record<string, unknown>;
    resolvedRemoteInstance?: RemoteInstanceRecord;
    resolvedReactionTargetType?: ReactionTargetType;
  }
}
