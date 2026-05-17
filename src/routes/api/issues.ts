import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import {
  ensureCommentAccess,
  ensureIssueAccess,
  ensureMilestoneAccess,
  ensureProjectAccess,
  ensureRelationAccess,
  getProjectRequestContext,
} from '../../services/project-permissions';
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
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    return listIssues(db, request.params.pid, request.query);
  });

  fastify.get<{ Params: { pid: string } }>('/projects/:pid/issues/counts', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    return getIssueCounts(db, request.params.pid);
  });

  fastify.post<{
    Params: { pid: string };
    Body: { title?: string; body?: string; created_by?: string; assigned_to?: string; labels?: string; parent_id?: string };
  }>('/projects/:pid/issues', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid, true);
    if (!access) return;
    const issue = createIssue(db, request.params.pid, request.body || {});
    return reply.code(201).send(issue);
  });

  fastify.get<{ Params: { id: string } }>('/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    return getIssueDetail(db, request.params.id);
  });

  fastify.put<{
    Params: { id: string };
    Body: { status?: string; assigned_to?: string; title?: string; body?: string; labels?: string; milestone_id?: string; actor?: string };
  }>('/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    return updateIssue(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    deleteIssue(db, request.params.id);
    return { success: true };
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { since_created_at?: string };
  }>('/issues/:id/comments', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
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
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    return acknowledgeIssue(db, request.params.id);
  });

  fastify.post<{ Params: { id: string } }>('/issues/:id/unacknowledge', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    return unacknowledgeIssue(db, request.params.id);
  });

  fastify.post<{
    Params: { id: string };
    Body: { author_id?: string; body?: string };
  }>('/issues/:id/comments', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const comment = addIssueComment(db, request.params.id, request.body || {});
    return reply.code(201).send(comment);
  });

  fastify.put<{
    Params: { id: string };
    Body: { body?: string };
  }>('/comments/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureCommentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    return updateIssueComment(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/comments/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureCommentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    deleteIssueComment(db, request.params.id);
    return { success: true };
  });

  fastify.get<{ Params: { pid: string; num: string } }>('/projects/:pid/issues/number/:num', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
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
      const access = ensureIssueAccess(db, request, reply, request.params.id, true);
      if (!access) return;
    } else {
      const access = ensureCommentAccess(db, request, reply, request.params.id, true);
      if (!access) return;
    }

    const result = toggleReaction(db, targetType, request.params.id, request.body || {});
    return result.toggled === 'on' ? reply.code(201).send(result) : result;
  });

  fastify.get<{ Params: { type: string; id: string } }>('/reactions/:type/:id', async (request, reply) => {
    const db = getDatabase();
    const targetType = request.params.type;
    assertReactionTargetType(targetType);

    if (targetType === 'issue') {
      const access = ensureIssueAccess(db, request, reply, request.params.id);
      if (!access) return;
    } else {
      const access = ensureCommentAccess(db, request, reply, request.params.id);
      if (!access) return;
    }

    return listReactions(db, targetType, request.params.id);
  });

  fastify.get<{ Params: { pid: string } }>('/projects/:pid/milestones', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    return listMilestones(db, request.params.pid);
  });

  fastify.post<{
    Params: { pid: string };
    Body: { title?: string; description?: string; due_date?: string };
  }>('/projects/:pid/milestones', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid, true);
    if (!access) return;
    const milestone = createMilestone(db, request.params.pid, request.body || {});
    return reply.code(201).send(milestone);
  });

  fastify.put<{
    Params: { id: string };
    Body: { title?: string; description?: string; due_date?: string; status?: string };
  }>('/milestones/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureMilestoneAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    return updateMilestone(db, request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/milestones/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureMilestoneAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    deleteMilestone(db, request.params.id);
    return { success: true };
  });

  fastify.get<{
    Params: { pid: string };
    Querystring: { q?: string };
  }>('/projects/:pid/search', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    return searchProjectIssues(db, request.params.pid, request.query.q || '');
  });

  fastify.post<{
    Params: { id: string };
    Body: { type?: string; target_issue_id?: string; actor?: string };
  }>('/issues/:id/relations', async (request, reply) => {
    const db = getDatabase();
    const sourceAccess = ensureIssueAccess(db, request, reply, request.params.id, true);
    if (!sourceAccess) return;
    const relation = createIssueRelation(db, request.params.id, request.body || {}, sourceAccess.entity.project_id);
    return reply.code(201).send(relation);
  });

  fastify.delete<{
    Params: { id: string; relationId: string };
  }>('/issues/:id/relations/:relationId', async (request, reply) => {
    const db = getDatabase();
    const issueAccess = ensureIssueAccess(db, request, reply, request.params.id, true);
    if (!issueAccess) return;
    const relationAccess = ensureRelationAccess(db, request, reply, request.params.relationId, true);
    if (!relationAccess) return;
    deleteIssueRelation(db, request.params.id, request.params.relationId);
    return { success: true };
  });

  fastify.get<{ Params: { id: string } }>('/issues/:id/relations', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    return listIssueRelations(db, request.params.id);
  });
}
