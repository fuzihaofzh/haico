import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Agent } from '../../types';
import { calculateKnowledgeExpiresAt } from './lifecycle';

const AGENT_KNOWLEDGE_TITLE = 'Agent Memory';
const AGENT_KNOWLEDGE_DEFAULT_IMPORTANCE = 'medium';
const AGENT_KNOWLEDGE_DEFAULT_CATEGORY = 'reference';
const REQUIRED_AGENT_KNOWLEDGE_TAGS = ['agent-profile', 'agent-memory'];

interface AgentKnowledgeRow {
  id: string;
  project_id: string;
  owner_agent_id: string | null;
  title: string;
  content: string;
  tags: string;
  importance: string;
  category: string;
  status: string;
}

export function hasLegacyAgentMemoriesTable(db: Database.Database): boolean {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_memories'"
  ).get() as { name: string } | undefined;
  return Boolean(table);
}

function normalizeTags(...values: Array<string | null | undefined>): string {
  const tags = new Set<string>();
  for (const required of REQUIRED_AGENT_KNOWLEDGE_TAGS) {
    tags.add(required);
  }
  for (const value of values) {
    if (!value) continue;
    for (const tag of String(value).split(',')) {
      const trimmed = tag.trim();
      if (trimmed) tags.add(trimmed);
    }
  }
  return Array.from(tags).join(',');
}

export function buildDefaultAgentKnowledgeContent(agent: Pick<Agent, 'role' | 'working_directory' | 'custom_instructions'>): string {
  return [
    '## 当前职责',
    agent.role?.trim() || '(待补充)',
    '',
    '## 常用资源',
    `- 工作目录: ${agent.working_directory?.trim() || '(未配置)'}`,
    '- 关键文档/入口: (待补充)',
    '',
    '## 常用命令',
    '- (待补充)',
    '',
    '## 代码架构认知',
    '- (待补充)',
    '',
    '## 长期注意事项',
    '- 完成任务前更新本条知识',
    '- 临时进展写到 issue comments，不要写在这里',
    '',
    '## 额外说明',
    `- Custom instructions: ${agent.custom_instructions?.trim() || '(无)'}`,
  ].join('\n');
}

function buildMigratedAgentKnowledgeContent(
  agent: Pick<Agent, 'role' | 'working_directory' | 'custom_instructions'>,
  memories: Array<{ content: string; tags: string }>
): string {
  const base = buildDefaultAgentKnowledgeContent(agent);
  const history = memories
    .map((memory) => `- ${memory.content}${memory.tags ? ` (tags: ${memory.tags})` : ''}`)
    .join('\n');
  if (!history) return base;
  return `${base}\n\n## 历史记忆迁移\n以下内容从旧版 agent_memories 迁入，请在后续任务中自行整理、去重、重写为稳定知识：\n${history}`;
}

export function getAgentKnowledgeEntry(
  db: Database.Database,
  projectId: string,
  agentId: string
): AgentKnowledgeRow | undefined {
  return db.prepare(
    `SELECT *
     FROM knowledge_entries
     WHERE project_id = ? AND owner_agent_id = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  ).get(projectId, agentId) as AgentKnowledgeRow | undefined;
}

export function createAgentKnowledgeEntry(
  db: Database.Database,
  agent: Pick<Agent, 'id' | 'project_id' | 'role' | 'working_directory' | 'custom_instructions'>,
  options: {
    content?: string;
    tags?: string;
    category?: string;
    importance?: string;
    actor?: string;
  } = {}
): AgentKnowledgeRow {
  const actor = (options.actor || agent.id || 'system').trim() || 'system';
  const category = options.category || AGENT_KNOWLEDGE_DEFAULT_CATEGORY;
  const importance = options.importance || AGENT_KNOWLEDGE_DEFAULT_IMPORTANCE;
  const content = options.content || buildDefaultAgentKnowledgeContent(agent);
  const tags = normalizeTags(options.tags);
  const id = randomUUID();
  const expiresAt = calculateKnowledgeExpiresAt(category as any);

  db.prepare(
    `INSERT INTO knowledge_entries
      (id, project_id, owner_agent_id, title, content, tags, importance, category, expires_at, last_verified_at, verified_by, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'active', ?)`
  ).run(
    id,
    agent.project_id,
    agent.id,
    AGENT_KNOWLEDGE_TITLE,
    content,
    tags,
    importance,
    category,
    expiresAt,
    actor,
    actor
  );

  return db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as AgentKnowledgeRow;
}

export function ensureAgentKnowledgeEntry(
  db: Database.Database,
  agent: Pick<Agent, 'id' | 'project_id' | 'role' | 'working_directory' | 'custom_instructions'>
): AgentKnowledgeRow {
  const existing = getAgentKnowledgeEntry(db, agent.project_id, agent.id);
  if (existing) return existing;
  return createAgentKnowledgeEntry(db, agent, { actor: agent.id });
}

export function upsertAgentKnowledgeEntry(
  db: Database.Database,
  agent: Pick<Agent, 'id' | 'project_id' | 'role' | 'working_directory' | 'custom_instructions'>,
  body: {
    content: string;
    tags?: string;
    category?: string;
    importance?: string;
    actor?: string;
  }
): AgentKnowledgeRow {
  const existing = getAgentKnowledgeEntry(db, agent.project_id, agent.id);
  const actor = (body.actor || agent.id || 'system').trim() || 'system';
  const category = body.category || existing?.category || AGENT_KNOWLEDGE_DEFAULT_CATEGORY;
  const importance = body.importance || existing?.importance || AGENT_KNOWLEDGE_DEFAULT_IMPORTANCE;
  const tags = normalizeTags(existing?.tags, body.tags);
  const expiresAt = calculateKnowledgeExpiresAt(category as any);

  if (!existing) {
    return createAgentKnowledgeEntry(db, agent, {
      content: body.content,
      tags,
      category,
      importance,
      actor,
    });
  }

  db.prepare(
    `UPDATE knowledge_entries
     SET title = ?, content = ?, tags = ?, importance = ?, category = ?, owner_agent_id = ?,
         expires_at = ?, last_verified_at = datetime('now'), verified_by = ?, status = 'active', updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    AGENT_KNOWLEDGE_TITLE,
    body.content,
    tags,
    importance,
    category,
    agent.id,
    expiresAt,
    actor,
    existing.id
  );

  return db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(existing.id) as AgentKnowledgeRow;
}

export function seedMissingAgentKnowledgeEntriesFromLegacyMemories(db: Database.Database): number {
  const agents = db.prepare(
    'SELECT id, project_id, role, working_directory, custom_instructions FROM agents ORDER BY created_at'
  ).all() as Array<Pick<Agent, 'id' | 'project_id' | 'role' | 'working_directory' | 'custom_instructions'>>;
  const selectLegacyMemories = hasLegacyAgentMemoriesTable(db)
    ? db.prepare(
      `SELECT content, tags
       FROM agent_memories
       WHERE project_id = ? AND agent_id = ? AND scope = 'private'
       ORDER BY created_at DESC`
    )
    : null;

  let created = 0;
  for (const agent of agents) {
    const existing = getAgentKnowledgeEntry(db, agent.project_id, agent.id);
    if (existing) continue;

    const memories = (selectLegacyMemories?.all(agent.project_id, agent.id) || []) as Array<{ content: string; tags: string }>;

    const content = memories.length > 0
      ? buildMigratedAgentKnowledgeContent(agent, memories)
      : buildDefaultAgentKnowledgeContent(agent);

    createAgentKnowledgeEntry(db, agent, {
      actor: agent.id,
      content,
      tags: memories.map((memory) => memory.tags).join(','),
    });
    created += 1;
  }

  return created;
}
