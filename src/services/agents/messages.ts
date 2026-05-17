import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { Agent, Project } from '../../types';
import { canMessageDirectHierarchyOnly } from './hierarchy';
import {
  AgentMessageNotFoundError,
  AgentMessageNotInAgentInboxError,
  AgentMessageOutsideDirectHierarchyError,
  AgentMessageRecipientNotFoundError,
  AgentMessageRecipientOutsideProjectError,
  AgentMessageReplyTargetNotFoundError,
  AgentMessageReplyTargetOutsideProjectError,
  AgentMessageSenderNotFoundError,
  MissingAgentMessageBodyError,
  MissingAgentMessageRecipientError,
} from './message-errors';
import { isAgentRunning, startAgentProcess } from '../process-manager';
import { buildSystemPrompt } from '../system-prompt';
import { broadcastToProject } from '../../realtime';

export interface AgentMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  project_id: string;
  subject: string;
  body: string;
  status: 'unread' | 'read';
  reply_to_id: string | null;
  created_at: string;
}

export interface SendAgentMessageInput {
  fromAgentId: string;
  toAgentId?: string;
  subject?: string;
  body?: string;
  replyToId?: string;
}

export interface ListAgentMessagesInput {
  agentId: string;
  status?: string;
  limit?: string;
}

interface ReplyTarget {
  id: string;
  project_id: string;
}

function parseMessageLimit(limit: string | undefined): number {
  return Math.min(parseInt(limit || '50', 10), 200);
}

function getAgentMessageOrThrow(db: Database.Database, messageId: string): AgentMessage {
  const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(messageId) as AgentMessage | undefined;
  if (!message) throw new AgentMessageNotFoundError();
  return message;
}

function getSenderAgentOrThrow(db: Database.Database, agentId: string): Agent {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  if (!agent) throw new AgentMessageSenderNotFoundError();
  return agent;
}

function getRecipientAgentOrThrow(db: Database.Database, agentId: string): Agent {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  if (!agent) throw new AgentMessageRecipientNotFoundError();
  return agent;
}

function validateMessageParticipants(db: Database.Database, fromAgent: Agent, toAgent: Agent): void {
  if (toAgent.project_id !== fromAgent.project_id) {
    throw new AgentMessageRecipientOutsideProjectError();
  }

  if (!canMessageDirectHierarchyOnly(db, fromAgent, toAgent.id)) {
    throw new AgentMessageOutsideDirectHierarchyError();
  }
}

function validateReplyTarget(db: Database.Database, replyToId: string | undefined, projectId: string): void {
  if (!replyToId) return;

  const replyTarget = db.prepare('SELECT id, project_id FROM agent_messages WHERE id = ?').get(replyToId) as ReplyTarget | undefined;
  if (!replyTarget) throw new AgentMessageReplyTargetNotFoundError();
  if (replyTarget.project_id !== projectId) {
    throw new AgentMessageReplyTargetOutsideProjectError();
  }
}

function createAgentMessage(
  db: Database.Database,
  input: Required<Pick<SendAgentMessageInput, 'fromAgentId' | 'toAgentId' | 'body'>> & Pick<SendAgentMessageInput, 'subject' | 'replyToId'>,
  projectId: string
): AgentMessage {
  const messageId = uuidv4();
  db.prepare(
    'INSERT INTO agent_messages (id, from_agent_id, to_agent_id, project_id, subject, body, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(messageId, input.fromAgentId, input.toAgentId, projectId, input.subject || '', input.body, input.replyToId || null);

  return getAgentMessageOrThrow(db, messageId);
}

function broadcastAgentMessageCreated(message: AgentMessage, fromAgent: Agent, toAgent: Agent): void {
  broadcastToProject(fromAgent.project_id, {
    type: 'agent_message',
    projectId: fromAgent.project_id,
    data: { message, from: fromAgent.name, to: toAgent.name },
  });
}

function maybeWakeRecipientAgent(
  db: Database.Database,
  fromAgent: Agent,
  toAgent: Agent,
  subject: string | undefined,
  body: string
): void {
  if (toAgent.paused || toAgent.status === 'running' || isAgentRunning(toAgent.id)) return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(toAgent.project_id) as Project | undefined;
  if (!project || project.status !== 'active') return;

  const prompt = `You received a direct message from ${fromAgent.name}.\n\nSubject: ${subject || '(none)'}\nMessage: ${body.slice(0, 500)}`;
  const commandTemplate = toAgent.command_template || project.command_template || config.defaultCommandTemplate;
  const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
  const systemPrompt = isRaw ? undefined : buildSystemPrompt(toAgent, project);
  startAgentProcess(toAgent, prompt, commandTemplate, systemPrompt);
}

export function sendAgentMessage(db: Database.Database, input: SendAgentMessageInput): AgentMessage {
  assertSendAgentMessageInput(input);

  const fromAgent = getSenderAgentOrThrow(db, input.fromAgentId);
  const toAgent = getRecipientAgentOrThrow(db, input.toAgentId);
  validateMessageParticipants(db, fromAgent, toAgent);
  validateReplyTarget(db, input.replyToId, fromAgent.project_id);

  const message = createAgentMessage(
    db,
    {
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      subject: input.subject,
      body: input.body,
      replyToId: input.replyToId,
    },
    fromAgent.project_id
  );

  broadcastAgentMessageCreated(message, fromAgent, toAgent);
  maybeWakeRecipientAgent(db, fromAgent, toAgent, input.subject, input.body);

  return message;
}

export function assertSendAgentMessageInput(input: SendAgentMessageInput): asserts input is SendAgentMessageInput & { toAgentId: string; body: string } {
  if (!input.toAgentId) throw new MissingAgentMessageRecipientError();
  if (!input.body) throw new MissingAgentMessageBodyError();
}

export function listAgentInboxMessages(db: Database.Database, input: ListAgentMessagesInput): AgentMessage[] {
  let sql = `SELECT m.*, a.name as from_name
    FROM agent_messages m
    LEFT JOIN agents a ON a.id = m.from_agent_id
    WHERE m.to_agent_id = ?`;
  const params: unknown[] = [input.agentId];

  if (input.status) {
    sql += ' AND m.status = ?';
    params.push(input.status);
  }

  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(parseMessageLimit(input.limit));

  return db.prepare(sql).all(...params) as AgentMessage[];
}

export function listAgentSentMessages(db: Database.Database, input: Omit<ListAgentMessagesInput, 'status'>): AgentMessage[] {
  return db.prepare(`
    SELECT m.*, a.name as to_name
    FROM agent_messages m
    LEFT JOIN agents a ON a.id = m.to_agent_id
    WHERE m.from_agent_id = ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(input.agentId, parseMessageLimit(input.limit)) as AgentMessage[];
}

export function markAgentMessageRead(db: Database.Database, agentId: string, messageId: string): AgentMessage {
  const message = getAgentMessageOrThrow(db, messageId);
  if (message.to_agent_id !== agentId) {
    throw new AgentMessageNotInAgentInboxError();
  }

  db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(messageId);
  return getAgentMessageOrThrow(db, messageId);
}

export function markAllAgentMessagesRead(db: Database.Database, agentId: string): number {
  const result = db.prepare("UPDATE agent_messages SET status = 'read' WHERE to_agent_id = ? AND status = 'unread'").run(agentId);
  return result.changes;
}
