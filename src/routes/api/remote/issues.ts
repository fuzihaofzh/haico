import { FastifyInstance } from 'fastify';
import {
  requestRemoteJsonPath,
  fetchRemoteIssue,
  acknowledgeRemoteIssue,
  updateRemoteIssue,
  deleteRemoteIssue,
  fetchRemoteIssueComments,
  createRemoteIssueComment,
  updateRemoteComment,
  deleteRemoteComment,
  toggleRemoteReaction,
  resolveRemoteIssueByNumber,
  addRemoteIssueRelation,
  removeRemoteIssueRelation,
} from '../../../services/remote-instances';
import {
  decorateRemoteIssueDetail,
  decorateRemoteIssueSummary,
  buildRemoteProxyPath,
  stripRemoteIssueId,
} from '../../../services/remote-instances/decorators';
import { requireRemoteInstancePrehandler } from '../../prehandlers';

export function registerRemoteIssueProxyRoutes(fastify: FastifyInstance): void {
  fastify.register(async (scope) => {
    scope.addHook('preHandler', requireRemoteInstancePrehandler());

    scope.get<{
      Params: { instanceId: string; projectId: string };
    }>('/remote-projects/:instanceId/:projectId/issues/counts', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/issues/counts`);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote issue counts' });
      }
      return result.data || {};
    });

    scope.get<{
      Params: { instanceId: string; projectId: string };
      Querystring: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/issues', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await requestRemoteJsonPath<any>(
        instance,
        buildRemoteProxyPath(`/api/projects/${encodeURIComponent(request.params.projectId)}/issues`, request.query)
      );
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote issues' });
      }
      const payload = result.data || {};
      return {
        ...payload,
        issues: Array.isArray(payload.issues)
          ? payload.issues.map((issue: any) => decorateRemoteIssueSummary(instance, request.params.projectId, issue))
          : [],
      };
    });

    scope.post<{
      Params: { instanceId: string; projectId: string };
      Body: Record<string, unknown>;
    }>('/remote-projects/:instanceId/:projectId/issues', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await requestRemoteJsonPath<any>(instance, `/api/projects/${encodeURIComponent(request.params.projectId)}/issues`, {
        method: 'POST',
        body: request.body || {},
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to create remote issue' });
      }
      return decorateRemoteIssueSummary(instance, request.params.projectId, result.data || {});
    });

    scope.get<{
      Params: { instanceId: string; projectId: string; num: string };
    }>('/remote-projects/:instanceId/:projectId/issues/number/:num', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await resolveRemoteIssueByNumber(instance, request.params.projectId, request.params.num);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to resolve remote issue' });
      }
      return decorateRemoteIssueDetail(instance, result.data || {});
    });

    scope.get<{
      Params: { instanceId: string; issueId: string };
    }>('/remote-issues/:instanceId/:issueId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await fetchRemoteIssue(instance, request.params.issueId);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote issue' });
      }
      return decorateRemoteIssueDetail(instance, result.data || {});
    });

    scope.post<{
      Params: { instanceId: string; issueId: string };
    }>('/remote-issues/:instanceId/:issueId/acknowledge', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await acknowledgeRemoteIssue(instance, request.params.issueId);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to acknowledge remote issue' });
      }
      return result.data || { ok: true };
    });

    scope.put<{
      Params: { instanceId: string; issueId: string };
      Body: Record<string, unknown>;
    }>('/remote-issues/:instanceId/:issueId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await updateRemoteIssue(instance, request.params.issueId, request.body || {});
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote issue' });
      }
      return result.data || { ok: true };
    });

    scope.delete<{
      Params: { instanceId: string; issueId: string };
    }>('/remote-issues/:instanceId/:issueId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await deleteRemoteIssue(instance, request.params.issueId);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote issue' });
      }
      return result.data || { success: true };
    });

    scope.get<{
      Params: { instanceId: string; issueId: string };
      Querystring: { since_created_at?: string };
    }>('/remote-issues/:instanceId/:issueId/comments', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await fetchRemoteIssueComments(instance, request.params.issueId, {
        since_created_at: typeof request.query?.since_created_at === 'string' ? request.query.since_created_at.trim() : '',
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to load remote comments' });
      }
      return Array.isArray(result.data)
        ? result.data.map((comment) => ({
            ...comment,
            remote_comment_id: String(comment?.id || ''),
          }))
        : [];
    });

    scope.post<{
      Params: { instanceId: string; issueId: string };
      Body: { author_id: string; body: string };
    }>('/remote-issues/:instanceId/:issueId/comments', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await createRemoteIssueComment(instance, request.params.issueId, request.body);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to add remote comment' });
      }
      return result.data ? {
        ...result.data,
        remote_comment_id: String((result.data as any)?.id || ''),
      } : { ok: true };
    });

    scope.put<{
      Params: { instanceId: string; commentId: string };
      Body: { body: string };
    }>('/remote-comments/:instanceId/:commentId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await updateRemoteComment(instance, request.params.commentId, request.body);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote comment' });
      }
      return result.data || { ok: true };
    });

    scope.delete<{
      Params: { instanceId: string; commentId: string };
    }>('/remote-comments/:instanceId/:commentId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await deleteRemoteComment(instance, request.params.commentId);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote comment' });
      }
      return result.data || { success: true };
    });

    scope.post<{
      Params: { instanceId: string; type: string; id: string };
      Body: { user_id: string; emoji: string };
    }>('/remote-reactions/:instanceId/:type/:id', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await toggleRemoteReaction(instance, request.params.type, request.params.id, request.body);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to update remote reaction' });
      }
      return result.data || { ok: true };
    });

    scope.post<{
      Params: { instanceId: string; issueId: string };
      Body: { type: string; target_issue_id: string; actor?: string };
    }>('/remote-issues/:instanceId/:issueId/relations', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await addRemoteIssueRelation(instance, request.params.issueId, {
        ...request.body,
        target_issue_id: stripRemoteIssueId(request.body?.target_issue_id),
      });
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to add remote relation' });
      }
      return result.data || { ok: true };
    });

    scope.delete<{
      Params: { instanceId: string; issueId: string; relationId: string };
    }>('/remote-issues/:instanceId/:issueId/relations/:relationId', async (request, reply) => {
      const instance = request.resolvedRemoteInstance!;

      const result = await removeRemoteIssueRelation(instance, request.params.issueId, request.params.relationId);
      if (!result.ok) {
        return reply.status(result.status || 502).send(result.data || { error: result.error || 'Failed to delete remote relation' });
      }
      return result.data || { success: true };
    });
  });
}
