import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/database';
import { CreateAgentInput } from '../../types';
import { getProjectRequestContext } from '../../middleware/request-context';
import { requireAgentAccess, requireProjectAccess } from '../../services/project-access';
import {
  AgentFileUploadResult,
  UpdateAgentInput,
  createAgent,
  deleteAgent,
  downloadAgentFile,
  finalizeAgentFileUpload,
  getAgent,
  getAgentCosts,
  getAgentFileContent,
  getAgentGitStatus,
  getAgentLogs,
  getAgentRunLogs,
  getAgentRunReport,
  getAgentStatus,
  getAgentSystemPrompt,
  getAgentTerminalText,
  listAgentFiles,
  listAgentRuns,
  listProjectAgents,
  pauseAgent,
  previewAgentSqliteFile,
  retryAgent,
  saveAgentFileContent,
  saveAgentUploadedFile,
  serveAgentFile,
  startAgent,
  stopAgent,
  unpauseAgent,
  updateAgent,
} from '../../services/agents/index';

export function registerAgentRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { pid: string } }>('/projects/:pid/agents', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid);
    return listProjectAgents(request.params.pid);
  });

  fastify.post<{ Params: { pid: string }; Body: CreateAgentInput }>('/projects/:pid/agents', async (request, reply) => {
    const db = getDatabase();
    requireProjectAccess(db, getProjectRequestContext(request), request.params.pid, true);
    const agent = createAgent(request.params.pid, (request.body || {}) as CreateAgentInput);
    return reply.code(201).send(agent);
  });

  fastify.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgent(request.params.id);
  });

  fastify.put<{ Params: { id: string }; Body: UpdateAgentInput }>('/agents/:id', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return updateAgent(request.params.id, request.body || {});
  });

  fastify.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return deleteAgent(request.params.id);
  });

  fastify.post<{ Params: { id: string }; Body: { prompt?: string; force_new_session?: boolean } }>('/agents/:id/start', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return startAgent(request.params.id, request.body || {});
  });

  fastify.post<{ Params: { id: string } }>('/agents/:id/retry', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return retryAgent(request.params.id);
  });

  fastify.post<{ Params: { id: string } }>('/agents/:id/stop', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return stopAgent(request.params.id, fastify.log);
  });

  fastify.post<{ Params: { id: string } }>('/agents/:id/pause', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return pauseAgent(request.params.id);
  });

  fastify.post<{ Params: { id: string } }>('/agents/:id/unpause', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return unpauseAgent(request.params.id);
  });

  fastify.get<{ Params: { id: string } }>('/agents/:id/status', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentStatus(request.params.id);
  });

  fastify.get<{ Params: { id: string } }>('/agents/:id/system-prompt', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentSystemPrompt(request.params.id);
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string; showHidden?: string } }>('/agents/:id/files', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return listAgentFiles(request.params.id, request.query.path, request.query.showHidden);
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/agents/:id/files/content', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    const content = await getAgentFileContent(request.params.id, request.query.path);
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/agents/:id/files/serve', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    const result = await serveAgentFile(request.params.id, request.query.path);
    if (result.applyHtmlPreviewCsp) {
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:");
    }
    return reply.type(result.contentType).send(result.buffer);
  });

  fastify.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>('/agents/:id/files/content', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);
    return saveAgentFileContent(request.params.id, request.body || {});
  });

  fastify.post<{ Params: { id: string } }>('/agents/:id/files/upload', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id, true);

    const parts = request.parts();
    let targetDir = '';
    const uploaded: AgentFileUploadResult[] = [];

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'path') {
        targetDir = String(part.value || '');
      } else if (part.type === 'file' && part.fieldname === 'file') {
        const fileName = part.filename;
        const buffer = await part.toBuffer();
        if (!fileName) {
          continue;
        }
        uploaded.push(await saveAgentUploadedFile(request.params.id, targetDir, fileName, buffer));
      }
    }

    return finalizeAgentFileUpload(uploaded);
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/agents/:id/files/download', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    const result = await downloadAgentFile(request.params.id, request.query.path);
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`)
      .type(result.contentType)
      .send(result.buffer);
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string; table?: string; limit?: string; offset?: string } }>('/agents/:id/files/sqlite', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return previewAgentSqliteFile(
      request.params.id,
      request.query.path,
      request.query.table,
      request.query.limit,
      request.query.offset
    );
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/terminal', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    const text = getAgentTerminalText(request.params.id, request.query.limit);
    return reply.type('text/plain').send(text);
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; since_id?: string; after_id?: string; after?: string } }>('/agents/:id/logs', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentLogs(request.params.id, request.query);
  });

  fastify.get<{ Params: { id: string } }>('/agents/:id/costs', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentCosts(request.params.id);
  });

  fastify.get<{ Params: { id: string; run_id: string } }>('/agents/:id/logs/:run_id', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentRunLogs(request.params.id, request.params.run_id);
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/runs', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return listAgentRuns(request.params.id, request.query.limit);
  });

  fastify.get<{ Params: { id: string } }>('/agents/:id/git-status', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentGitStatus(request.params.id);
  });

  fastify.get<{ Params: { id: string; run_id: string } }>('/agents/:id/runs/:run_id/report', async (request, reply) => {
    const db = getDatabase();
    requireAgentAccess(db, getProjectRequestContext(request), request.params.id);
    return getAgentRunReport(request.params.id, request.params.run_id);
  });
}
