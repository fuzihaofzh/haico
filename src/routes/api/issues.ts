import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { getProjectRequestContext } from '../../middleware/request-context';
import { acknowledgeIssue, addIssueComment, createIssueRelation, createIssue, deleteIssueComment, deleteIssueRelation, deleteIssue, getIssueByNumberDetail, getIssueCounts, getIssueDetail, getIssueNotifications, listIssueComments, listIssueRelations, listIssues, listMyIssues, searchProjectIssues, searchInboxIssues, unacknowledgeIssue, updateIssueComment, updateIssue } from '../../services/issue';
import { assertReactionTargetType, listReactions, toggleReaction } from '../../services/reactions';
import { createMilestone, deleteMilestone, listMilestones, updateMilestone } from '../../services/milestones';
import { requireProjectAccessPrehandler, requireEntityAccessPrehandler, requireReactionTargetTypePrehandler } from '../prehandlers';

export function registerIssueRoutes(fastify: FastifyInstance): void {
  // Project-scoped routes (require project access)
  fastify.get<{
    Params: { pid: string };
    Querystring: { status?: string; assigned_to?: string; label?: string; q?: string; sort?: string; page?: string; per_page?: string; milestone_id?: string };
  }>('/projects/:pid/issues', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    return listIssues(db, request.params.pid, request.query);
  });

  fastify.get<{ Params: { pid: string } }>('/projects/:pid/issues/counts', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    return getIssueCounts(db, request.params.pid);
  });

  fastify.post<{
    Params: { pid: string };
    Body: { title?: string; body?: string; created_by?: string; assigned_to?: string; labels?: string; parent_id?: string };
  }>('/projects/:pid/issues', { preHandler: [requireProjectAccessPrehandler({ manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    const issue = createIssue(db, request.params.pid, request.body || {});
    return reply.code(201).send(issue);
  });

  fastify.get<{ Params: { pid: string; num: string } }>('/projects/:pid/issues/number/:num', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    return getIssueByNumberDetail(db, request.params.pid, Number.parseInt(request.params.num, 10));
  });

  fastify.get<{ Params: { pid: string } }>('/projects/:pid/milestones', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    return listMilestones(db, request.params.pid);
  });

  fastify.post<{
    Params: { pid: string };
    Body: { title?: string; description?: string; due_date?: string };
  }>('/projects/:pid/milestones', { preHandler: [requireProjectAccessPrehandler({ manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    const milestone = createMilestone(db, request.params.pid, request.body || {});
    return reply.code(201).send(milestone);
  });

  fastify.get<{ Params: { pid: string }; Querystring: { q?: string } }>('/projects/:pid/search', { preHandler: [requireProjectAccessPrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    return searchProjectIssues(db, request.params.pid, request.query.q || '');
  });

  // Issue entity routes (read-only access)
  fastify.get<{ Params: { id: string } }>('/issues/:id', { preHandler: [requireEntityAccessPrehandler('issue')] }, async (request, reply) => {
    const db = getDatabase();
    return getIssueDetail(db, request.params.id);
  });

  fastify.get<{ Params: { id: string }; Querystring: { since_created_at?: string } }>('/issues/:id/comments', { preHandler: [requireEntityAccessPrehandler('issue')] }, async (request, reply) => {
    const db = getDatabase();
    const sinceCreatedAt = typeof request.query.since_created_at === 'string'
      ? request.query.since_created_at.trim()
      : '';
    return listIssueComments(db, request.params.id, sinceCreatedAt || undefined);
  });

  fastify.post<{ Params: { id: string } }>('/issues/:id/acknowledge', { preHandler: [requireEntityAccessPrehandler('issue')] }, async (request, reply) => {
    const db = getDatabase();
    return acknowledgeIssue(db, request.params.id);
  });

  fastify.post<{ Params: { id: string } }>('/issues/:id/unacknowledge', { preHandler: [requireEntityAccessPrehandler('issue')] }, async (request, reply) => {
    const db = getDatabase();
    return unacknowledgeIssue(db, request.params.id);
  });

  fastify.get<{ Params: { id: string } }>('/issues/:id/relations', { preHandler: [requireEntityAccessPrehandler('issue')] }, async (request, reply) => {
    const db = getDatabase();
    return listIssueRelations(db, request.params.id);
  });

  // Issue entity routes (manage access)
  fastify.put<{
    Params: { id: string };
    Body: { status?: string; assigned_to?: string; title?: string; body?: string; labels?: string; milestone_id?: string; actor?: string };
  }>('/issues/:id', { preHandler: [requireEntityAccessPrehandler('issue', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    return updateIssue(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/issues/:id', { preHandler: [requireEntityAccessPrehandler('issue', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    deleteIssue(db, request.params.id);
    return { success: true };
  });

  fastify.post<{
    Params: { id: string };
    Body: { author_id?: string; body?: string };
  }>('/issues/:id/comments', { preHandler: [requireEntityAccessPrehandler('issue', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    const comment = addIssueComment(db, request.params.id, request.body || {});
    return reply.code(201).send(comment);
  });

  fastify.post<{
    Params: { id: string };
    Body: { type?: string; target_issue_id?: string; actor?: string };
  }>('/issues/:id/relations', { preHandler: [requireEntityAccessPrehandler('issue', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    const relation = createIssueRelation(db, request.params.id, request.body || {}, (request.resolvedEntity! as any).project_id);
    return reply.code(201).send(relation);
  });

  fastify.delete<{
    Params: { id: string; relationId: string };
  }>('/issues/:id/relations/:relationId', { preHandler: [requireEntityAccessPrehandler('issue', { manage: true }), requireEntityAccessPrehandler('relation', { param: 'relationId', manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    deleteIssueRelation(db, request.params.id, request.params.relationId);
    return { success: true };
  });

  // Comment entity routes (manage access)
  fastify.put<{
    Params: { id: string };
    Body: { body?: string };
  }>('/comments/:id', { preHandler: [requireEntityAccessPrehandler('comment', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    return updateIssueComment(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/comments/:id', { preHandler: [requireEntityAccessPrehandler('comment', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    deleteIssueComment(db, request.params.id);
    return { success: true };
  });

  // Milestone routes (manage access)
  fastify.put<{
    Params: { id: string };
    Body: { title?: string; description?: string; due_date?: string; status?: string };
  }>('/milestones/:id', { preHandler: [requireEntityAccessPrehandler('milestone', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    return updateMilestone(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/milestones/:id', { preHandler: [requireEntityAccessPrehandler('milestone', { manage: true })] }, async (request, reply) => {
    const db = getDatabase();
    deleteMilestone(db, request.params.id);
    return { success: true };
  });

  // Reactions - branching logic needs inline handler for dynamic access check
  fastify.post<{ Params: { type: string; id: string }; Body: { user_id?: string; emoji?: string } }>(
    '/reactions/:type/:id',
    { preHandler: [requireReactionTargetTypePrehandler()] },
    async (request, reply) => {
      const db = getDatabase();
      const targetType = request.params.type;
      assertReactionTargetType(targetType);

      if (targetType === 'issue') {
        await requireEntityAccessPrehandler('issue', { manage: true })(request);
      } else {
        await requireEntityAccessPrehandler('comment', { manage: true })(request);
      }

      const result = toggleReaction(db, targetType, request.params.id, request.body || {});
      return result.toggled === 'on' ? reply.code(201).send(result) : result;
    }
  );

  fastify.get<{ Params: { type: string; id: string } }>('/reactions/:type/:id', { preHandler: [requireReactionTargetTypePrehandler()] }, async (request, reply) => {
    const db = getDatabase();
    const targetType = request.params.type;
    assertReactionTargetType(targetType);

    if (targetType === 'issue') {
      await requireEntityAccessPrehandler('issue')(request);
    } else {
      await requireEntityAccessPrehandler('comment')(request);
    }

    return listReactions(db, targetType, request.params.id);
  });

  // Non-access routes
  fastify.get('/notifications', async (request) => {
    const db = getDatabase();
    return getIssueNotifications(db, getProjectRequestContext(request), request.query as any);
  });

  fastify.get('/my-issues', async (request) => {
    const db = getDatabase();
    return listMyIssues(db, getProjectRequestContext(request));
  });

  fastify.get<{ Querystring: { q?: string } }>('/inbox/search', async (request) => {
    const db = getDatabase();
    return searchInboxIssues(db, getProjectRequestContext(request), request.query.q || '');
  });
}
