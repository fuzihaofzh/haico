import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { getProjectRequestContext } from '../../middleware/request-context';
import {
  requireCommentAccess,
  requireIssueAccess,
  requireMilestoneAccess,
  requireProjectAccess,
  requireRelationAccess,
} from '../../services/project-access';
import {
  acknowledgeIssue,
  addIssueComment,
  createIssueRelation,
  createIssue,
  deleteIssueComment,
  deleteIssueRelation,
  deleteIssue,
  getIssueByNumberDetail,
  getIssueCounts,
  getIssueDetail,
  getIssueNotifications,
  listIssueComments,
  listIssueRelations,
  listIssues,
  listMyIssues,
  searchProjectIssues,
  searchInboxIssues,
  unacknowledgeIssue,
  updateIssueComment,
  updateIssue,
} from '../../services/issue';
import {
  assertReactionTargetType,
  listReactions,
  toggleReaction,
} from '../../services/reactions';
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  updateMilestone,
} from '../../services/milestones';

export function registerIssueRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { pid: string };
    Querystring: { status?: string; assigned_to?: string; label?: string; q?: string; sort?: string; page?: string; per_page?: string; milestone_id?: string };
  }>('/projects/:pid/issues', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);
    return listIssues(db, request.params.pid, request.query);
  });

  fastify.get<{ Params: { pid: string } }>('/projects/:pid/issues/counts', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);
    return getIssueCounts(db, request.params.pid);
  });

  fastify.post<{
    Params: { pid: string };
    Body: { title?: string; body?: string; created_by?: string; assigned_to?: string; labels?: string; parent_id?: string };
  }>('/projects/:pid/issues', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid, true);
    const issue = createIssue(db, request.params.pid, request.body || {});
    return reply.code(201).send(issue);
  });

  fastify.get<{ Params: { id: string } }>('/issues/:id', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id);
    return getIssueDetail(db, request.params.id);
  });

  fastify.put<{
    Params: { id: string };
    Body: { status?: string; assigned_to?: string; title?: string; body?: string; labels?: string; milestone_id?: string; actor?: string };
  }>('/issues/:id', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id, true);
    return updateIssue(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/issues/:id', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id, true);
    deleteIssue(db, request.params.id);
    return { success: true };
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { since_created_at?: string };
  }>('/issues/:id/comments', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id);
    const sinceCreatedAt = typeof request.query.since_created_at === 'string'
      ? request.query.since_created_at.trim()
      : '';
    return listIssueComments(db, request.params.id, sinceCreatedAt || undefined);
  });

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

  fastify.post<{ Params: { id: string } }>('/issues/:id/acknowledge', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id);
    return acknowledgeIssue(db, request.params.id);
  });

  fastify.post<{ Params: { id: string } }>('/issues/:id/unacknowledge', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id);
    return unacknowledgeIssue(db, request.params.id);
  });

  fastify.post<{
    Params: { id: string };
    Body: { author_id?: string; body?: string };
  }>('/issues/:id/comments', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id, true);
    const comment = addIssueComment(db, request.params.id, request.body || {});
    return reply.code(201).send(comment);
  });

  fastify.put<{
    Params: { id: string };
    Body: { body?: string };
  }>('/comments/:id', async (request, reply) => {
    const db = getDatabase();
    requireCommentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return updateIssueComment(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/comments/:id', async (request, reply) => {
    const db = getDatabase();
    requireCommentAccess(db, getProjectRequestContext(request), request.params.id, true);
    deleteIssueComment(db, request.params.id);
    return { success: true };
  });

  fastify.get<{ Params: { pid: string; num: string } }>('/projects/:pid/issues/number/:num', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);
    return getIssueByNumberDetail(db, request.params.pid, Number.parseInt(request.params.num, 10));
  });

  fastify.post<{
    Params: { type: string; id: string };
    Body: { user_id?: string; emoji?: string };
  }>('/reactions/:type/:id', async (request, reply) => {
    const db = getDatabase();
    const targetType = request.params.type;
    assertReactionTargetType(targetType);

    if (targetType === 'issue') {
      requireIssueAccess(db, getProjectRequestContext(request), request.params.id, true);
    } else {
      requireCommentAccess(db, getProjectRequestContext(request), request.params.id, true);
    }

    const result = toggleReaction(db, targetType, request.params.id, request.body || {});
    return result.toggled === 'on' ? reply.code(201).send(result) : result;
  });

  fastify.get<{ Params: { type: string; id: string } }>('/reactions/:type/:id', async (request, reply) => {
    const db = getDatabase();
    const targetType = request.params.type;
    assertReactionTargetType(targetType);

    if (targetType === 'issue') {
      requireIssueAccess(db, getProjectRequestContext(request), request.params.id);
    } else {
      requireCommentAccess(db, getProjectRequestContext(request), request.params.id);
    }

    return listReactions(db, targetType, request.params.id);
  });

  fastify.get<{ Params: { pid: string } }>('/projects/:pid/milestones', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);
    return listMilestones(db, request.params.pid);
  });

  fastify.post<{
    Params: { pid: string };
    Body: { title?: string; description?: string; due_date?: string };
  }>('/projects/:pid/milestones', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid, true);
    const milestone = createMilestone(db, request.params.pid, request.body || {});
    return reply.code(201).send(milestone);
  });

  fastify.put<{
    Params: { id: string };
    Body: { title?: string; description?: string; due_date?: string; status?: string };
  }>('/milestones/:id', async (request, reply) => {
    const db = getDatabase();
    requireMilestoneAccess(db, getProjectRequestContext(request), request.params.id, true);
    return updateMilestone(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/milestones/:id', async (request, reply) => {
    const db = getDatabase();
    requireMilestoneAccess(db, getProjectRequestContext(request), request.params.id, true);
    deleteMilestone(db, request.params.id);
    return { success: true };
  });

  fastify.get<{
    Params: { pid: string };
    Querystring: { q?: string };
  }>('/projects/:pid/search', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);
    return searchProjectIssues(db, request.params.pid, request.query.q || '');
  });

  fastify.post<{
    Params: { id: string };
    Body: { type?: string; target_issue_id?: string; actor?: string };
  }>('/issues/:id/relations', async (request, reply) => {
    const db = getDatabase();
    const sourceAccess = requireIssueAccess(db, getProjectRequestContext(request), request.params.id, true);
    const relation = createIssueRelation(db, request.params.id, request.body || {}, sourceAccess.entity.project_id);
    return reply.code(201).send(relation);
  });

  fastify.delete<{
    Params: { id: string; relationId: string };
  }>('/issues/:id/relations/:relationId', async (request, reply) => {
    const db = getDatabase();
    const context = getProjectRequestContext(request);
    requireIssueAccess(db, context, request.params.id, true);
    requireRelationAccess(db, context, request.params.relationId, true);
    deleteIssueRelation(db, request.params.id, request.params.relationId);
    return { success: true };
  });

  fastify.get<{ Params: { id: string } }>('/issues/:id/relations', async (request, reply) => {
    const db = getDatabase();
    requireIssueAccess(db, getProjectRequestContext(request), request.params.id);
    return listIssueRelations(db, request.params.id);
  });
}
