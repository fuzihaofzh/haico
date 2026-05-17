import { FastifyInstance, FastifyRequest } from 'fastify';
import { getDatabase } from '../db/database';
import {
  attachAgentOutputSocket,
  attachProjectEventSocket,
  attachTerminalSocket,
} from '../realtime';
import {
  getProjectRequestContext,
  requireAgentAccess,
  requireProjectAccess,
} from '../services/project-access';

function parseTerminalDimension(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function registerWebSocketRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { id: string } }>(
    '/ws/agents/:id/terminal',
    {
      websocket: true,
      preValidation: async (request: FastifyRequest<{ Params: { id: string } }>) => {
        requireAgentAccess(getDatabase(), getProjectRequestContext(request), request.params.id);
      },
    },
    (socket, request) => {
      attachAgentOutputSocket(request.params.id, socket);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/ws/projects/:id/events',
    {
      websocket: true,
      preValidation: async (request: FastifyRequest<{ Params: { id: string } }>) => {
        requireProjectAccess(getDatabase(), getProjectRequestContext(request), request.params.id);
      },
    },
    (socket, request) => {
      attachProjectEventSocket(request.params.id, socket);
    }
  );

  fastify.get<{
    Params: { agentId: string };
    Querystring: { newSession?: string; cols?: string; rows?: string };
  }>(
    '/ws/terminal/:agentId',
    {
      websocket: true,
      preValidation: async (
        request: FastifyRequest<{
          Params: { agentId: string };
          Querystring: { newSession?: string; cols?: string; rows?: string };
        }>
      ) => {
        requireAgentAccess(getDatabase(), getProjectRequestContext(request), request.params.agentId, true);
      },
    },
    (socket, request) => {
      attachTerminalSocket(request.params.agentId, socket, request, {
        newSession: request.query.newSession === 'true',
        cols: parseTerminalDimension(request.query.cols, 120),
        rows: parseTerminalDimension(request.query.rows, 30),
      });
    }
  );
}
