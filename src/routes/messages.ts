import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { broadcastToProject } from '../services/websocket';
import { startAgentProcess, isAgentRunning } from '../services/process-manager';
import { buildSystemPrompt } from '../services/system-prompt';
import { config } from '../config';

export function registerMessageRoutes(fastify: FastifyInstance): void {
  // Send a message to an agent
  fastify.post<{ Params: { id: string }; Body: { to: string; subject?: string; body: string; reply_to_id?: string } }>(
    '/api/agents/:id/messages/send',
    async (request, reply) => {
      const db = getDatabase();
      const fromAgentId = request.params.id;
      const { to, subject, body, reply_to_id } = request.body as any;

      if (!to || !body) return reply.status(400).send({ error: 'to and body are required' });

      const fromAgent = db.prepare('SELECT * FROM agents WHERE id = ?').get(fromAgentId) as Agent | undefined;
      const toAgent = db.prepare('SELECT * FROM agents WHERE id = ?').get(to) as Agent | undefined;
      if (!fromAgent) return reply.status(404).send({ error: 'Sender agent not found' });
      if (!toAgent) return reply.status(404).send({ error: 'Recipient agent not found' });

      if (reply_to_id) {
        const replyMsg = db.prepare('SELECT id FROM agent_messages WHERE id = ?').get(reply_to_id);
        if (!replyMsg) return reply.status(400).send({ error: 'reply_to message not found' });
      }

      const msgId = uuidv4();
      db.prepare(
        'INSERT INTO agent_messages (id, from_agent_id, to_agent_id, project_id, subject, body, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(msgId, fromAgentId, to, fromAgent.project_id, subject || '', body, reply_to_id || null);

      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(msgId);

      // WebSocket notification
      broadcastToProject(fromAgent.project_id, {
        type: 'agent_message',
        projectId: fromAgent.project_id,
        data: { message, from: fromAgent.name, to: toAgent.name },
      });

      // Auto-wake idle agent
      if (!toAgent.paused && toAgent.status !== 'running' && !isAgentRunning(toAgent.id)) {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(toAgent.project_id) as Project | undefined;
        if (project && project.status === 'active') {
          const prompt = `You received a direct message from ${fromAgent.name}.\n\nSubject: ${subject || '(none)'}\nMessage: ${body.slice(0, 500)}`;
          const commandTemplate = toAgent.command_template || project.command_template || config.defaultCommandTemplate;
          const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
          const systemPrompt = isRaw ? undefined : buildSystemPrompt(toAgent, project);
          startAgentProcess(toAgent, prompt, commandTemplate, systemPrompt);
        }
      }

      return reply.status(201).send(message);
    }
  );

  // Get inbox (messages received by this agent)
  fastify.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    '/api/agents/:id/messages',
    async (request) => {
      const db = getDatabase();
      const { id } = request.params;
      const { status, limit } = request.query;
      const maxResults = Math.min(parseInt(limit || '50', 10), 200);

      let sql = `SELECT m.*, a.name as from_name
        FROM agent_messages m
        LEFT JOIN agents a ON a.id = m.from_agent_id
        WHERE m.to_agent_id = ?`;
      const params: any[] = [id];

      if (status) {
        sql += ' AND m.status = ?';
        params.push(status);
      }

      sql += ' ORDER BY m.created_at DESC LIMIT ?';
      params.push(maxResults);

      return { messages: db.prepare(sql).all(...params) };
    }
  );

  // Get sent messages
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/agents/:id/messages/sent',
    async (request) => {
      const db = getDatabase();
      const { id } = request.params;
      const maxResults = Math.min(parseInt(request.query.limit || '50', 10), 200);

      const messages = db.prepare(`
        SELECT m.*, a.name as to_name
        FROM agent_messages m
        LEFT JOIN agents a ON a.id = m.to_agent_id
        WHERE m.from_agent_id = ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(id, maxResults);

      return { messages };
    }
  );

  // Mark message as read
  fastify.put<{ Params: { id: string; msgId: string } }>(
    '/api/agents/:id/messages/:msgId',
    async (request, reply) => {
      const db = getDatabase();
      const { msgId } = request.params;
      const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(msgId) as any;
      if (!msg) return reply.status(404).send({ error: 'Message not found' });

      db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(msgId);
      return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(msgId);
    }
  );

  // Mark all messages as read for an agent
  fastify.post<{ Params: { id: string } }>(
    '/api/agents/:id/messages/read-all',
    async (request) => {
      const db = getDatabase();
      const result = db.prepare("UPDATE agent_messages SET status = 'read' WHERE to_agent_id = ? AND status = 'unread'").run(request.params.id);
      return { updated: result.changes };
    }
  );
}
