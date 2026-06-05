import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { CreateProjectInput } from '../../types';
import { getProjectRequestContext } from '../../middleware/request-context';
import { assertProjectTaskDescription } from '../../services/projects/core';
import { requireProjectAccessPrehandler } from '../prehandlers';
import { buildProjectExport, buildProjectIssuesCsv, createProject, deleteProject, generateProjectMetadata, getDashboardActivityStream, getDashboardSummary, getProject, getProjectActivity, getProjectCosts, getProjectGitLog, getTodayCost, getUsageByProject, listDashboardAgents, listProjectMembers, listProjectOrchestrationRuns, listProjects, removeProjectMember, updateProject, updateProjectMemberRole, upsertProjectMember } from '../../services/projects';
import { createRemoteProject, findRemoteInstanceById, generateRemoteProjectMetadata, isLocalTargetInstanceId } from '../../services/remote-instances';
import { RemoteInstanceNotFoundError, RemoteInstanceDisabledError } from '../../services/remote-instances/errors';
import { triggerControllerOnDemand } from '../../services/issue/automation';
import { listProjectExecutorProfiles } from '../../services/executors/profiles';

export function registerProjectRoutes(fastify: FastifyInstance): void {
  fastify.get('/dashboard/summary', async (request) => {
    const db = getDatabase();
    return getDashboardSummary(db, getProjectRequestContext(request));
  });

  fastify.get<{ Querystring: { period?: string } }>('/dashboard/usage-by-project', async (request) => {
    const db = getDatabase();
    return getUsageByProject(db, getProjectRequestContext(request), request.query.period);
  });

  fastify.get<{ Querystring: { limit?: string; project_id?: string } }>('/dashboard/activity-stream', async (request) => {
    const db = getDatabase();
    return getDashboardActivityStream(db, getProjectRequestContext(request), request.query);
  });

  fastify.get<{ Querystring: { status?: string } }>('/dashboard/agents', async (request) => {
    const db = getDatabase();
    return listDashboardAgents(db, getProjectRequestContext(request), request.query.status);
  });

  fastify.get('/dashboard/today-cost', async (request) => {
    const db = getDatabase();
    return getTodayCost(db, getProjectRequestContext(request));
  });

  fastify.post<{ Body: { description: string; tool_path: string; command_type?: string | null; target_instance_id?: string | null } }>(
    '/generate-project',
    async (request, reply) => {
      const { description, tool_path, command_type, target_instance_id } = request.body || {} as any;

      if (!description) {
        return generateProjectMetadata({ description, tool_path, command_type });
      }

      if (!isLocalTargetInstanceId(target_instance_id)) {
        const db = getDatabase();
        const remoteInstance = findRemoteInstanceById(db, String(target_instance_id || '').trim());
        if (!remoteInstance) {
          throw new RemoteInstanceNotFoundError();
        }
        if (!remoteInstance.enabled) {
          throw new RemoteInstanceDisabledError();
        }

        const result = await generateRemoteProjectMetadata(remoteInstance, {
          description,
          tool_path,
          command_type,
        });
        if (!result.ok) {
          return reply.code(result.status || 502).send(
            result.data || { error: result.error || 'Failed to generate project metadata on remote instance' }
          );
        }
        return result.data;
      }

      return generateProjectMetadata({ description, tool_path, command_type });
    }
  );

  fastify.get<{ Querystring: { with_stats?: string } }>('/projects', async (request) => {
    const db = getDatabase();
    return listProjects(db, getProjectRequestContext(request), {
      withStats: request.query.with_stats === '1',
    });
  });

  fastify.post<{ Body: CreateProjectInput }>('/projects', async (request, reply) => {
    const body = request.body || {} as CreateProjectInput;
    assertProjectTaskDescription(body);

    if (!isLocalTargetInstanceId(body.target_instance_id)) {
      const db = getDatabase();
      const remoteInstance = findRemoteInstanceById(db, String(body.target_instance_id || '').trim());
      if (!remoteInstance) {
        throw new RemoteInstanceNotFoundError();
      }
      if (!remoteInstance.enabled) {
        throw new RemoteInstanceDisabledError();
      }

      const result = await createRemoteProject(remoteInstance, {
        name: body.name,
        description: body.description,
        task_description: body.task_description,
        command_profile_id: body.command_profile_id,
        command_template: body.command_template,
        command_type: body.command_type,
        orchestrator_engine: body.orchestrator_engine,
        working_directory: body.working_directory,
        controller_role: body.controller_role,
      });
      if (!result.ok) {
        return reply.code(result.status || 502).send(
          result.data || { error: result.error || 'Failed to create project on remote instance' }
        );
      }
      return reply.code(201).send(result.data);
    }

    const db = getDatabase();
    const project = createProject(db, body, getProjectRequestContext(request));
    return reply.code(201).send(project);
  });

  fastify.register(async (projectReadScope) => {
    projectReadScope.addHook('preHandler', requireProjectAccessPrehandler({ param: 'id', manage: false }));

    projectReadScope.get<{ Params: { id: string }; Querystring: { period?: string } }>('/projects/:id/costs', async (request) => {
      const db = getDatabase();
      return getProjectCosts(db, request.params.id, request.query.period);
    });

    projectReadScope.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/projects/:id/git-log', async (request) => {
      const db = getDatabase();
      return getProjectGitLog(db, request.params.id, request.query.limit);
    });

    projectReadScope.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/projects/:id/activity', async (request) => {
      const db = getDatabase();
      return getProjectActivity(db, request.params.id, request.query.limit);
    });

    projectReadScope.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/projects/:id/orchestration-runs', async (request) => {
      const db = getDatabase();
      return listProjectOrchestrationRuns(db, request.params.id, request.query.limit);
    });

    projectReadScope.get<{ Params: { id: string } }>('/projects/:id', async (request) => {
      const db = getDatabase();
      return getProject(db, request.params.id, request.projectPermission!);
    });

    projectReadScope.get<{ Params: { id: string } }>('/projects/:id/members', async (request) => {
      const db = getDatabase();
      return { members: listProjectMembers(db, request.params.id) };
    });

    projectReadScope.get<{ Params: { id: string } }>('/projects/:id/export', async (request, reply) => {
      const db = getDatabase();
      const result = buildProjectExport(db, request.params.id);
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="${result.fileName}"`);
      return result.data;
    });

    projectReadScope.get<{ Params: { id: string } }>('/projects/:id/export/issues.csv', async (request, reply) => {
      const db = getDatabase();
      const result = buildProjectIssuesCsv(db, request.params.id);
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${result.fileName}"`);
      return result.csv;
    });

    projectReadScope.get<{ Params: { id: string } }>('/projects/:id/executor-profiles', async (request) => {
      const db = getDatabase();
      return { profiles: listProjectExecutorProfiles(db, request.params.id) };
    });
  });

  fastify.register(async (projectWriteScope) => {
    projectWriteScope.addHook('preHandler', requireProjectAccessPrehandler({ param: 'id', manage: true }));

    projectWriteScope.post<{ Params: { id: string }; Body: { issue_number?: number } }>('/projects/:id/controller/trigger', async (request) => {
      const db = getDatabase();
      const issueNumber = typeof request.body?.issue_number === 'number'
        ? request.body.issue_number
        : undefined;
      triggerControllerOnDemand(db, request.params.id, issueNumber, 'user', {
        reason: 'manual-controller-trigger',
        forceUrgent: true,
      });
      return { success: true };
    });

    projectWriteScope.put<{ Params: { id: string }; Body: Partial<CreateProjectInput> & { status?: string; color?: string } }>('/projects/:id', async (request) => {
      const db = getDatabase();
      return updateProject(db, request.params.id, request.body || {}, request.projectPermission!);
    });

    projectWriteScope.post<{ Params: { id: string }; Body: { user_id?: string; username?: string; role?: string } }>('/projects/:id/members', async (request, reply) => {
      const db = getDatabase();
      const result = upsertProjectMember(db, request.params.id, request.body || {});
      return reply.code(result.created ? 201 : 200).send(result.member);
    });

    projectWriteScope.delete<{ Params: { id: string; userId: string } }>('/projects/:id/members/:userId', async (request) => {
      const db = getDatabase();
      return removeProjectMember(db, request.params.id, request.params.userId);
    });

    projectWriteScope.patch<{ Params: { id: string; userId: string }; Body: { role: string } }>('/projects/:id/members/:userId', async (request) => {
      const db = getDatabase();
      return updateProjectMemberRole(db, request.params.id, request.params.userId, request.body?.role);
    });

    projectWriteScope.delete<{ Params: { id: string } }>('/projects/:id', async (request) => {
      const db = getDatabase();
      return deleteProject(db, request.params.id, request.projectPermission!, request.log);
    });
  });
}
