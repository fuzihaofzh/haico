import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import logger from '../logger';
import {
  hasLegacyAgentMemoriesTable,
  seedMissingAgentKnowledgeEntriesFromLegacyMemories,
} from '../services/knowledge/agent-memory';

function cleanupLegacyAgentMemoriesArtifacts(db: Database.Database): void {
  const legacyMemoriesTableExists = hasLegacyAgentMemoriesTable(db);
  const legacyMemoriesFtsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
  ).get() as { name: string } | undefined;
  const legacyMemoriesTriggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au')"
  ).all() as Array<{ name: string }>;

  if (!legacyMemoriesTableExists && !legacyMemoriesFtsExists && legacyMemoriesTriggers.length === 0) {
    return;
  }

  db.exec(`
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS agent_memories;
    DROP TABLE IF EXISTS agent_memories_old;
  `);
  logger.info('Migration: removed legacy agent_memories artifacts');
}

/**
 * Seed FTS5 virtual table for knowledge full-text search.
 * Idempotent — checks for existing FTS table before creating.
 */
export function seedKnowledgeFts(db: Database.Database): void {
  const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'").get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, content, content=knowledge_entries, content_rowid=rowid);
    `);
    db.exec(`
      INSERT INTO knowledge_fts(rowid, title, content)
      SELECT rowid, title, content FROM knowledge_entries;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
    `);
    logger.info('Migration: created FTS5 virtual table for knowledge full-text search');
  }
}

/**
 * Migrate legacy agent_memories into knowledge_entries, then clean up legacy artifacts.
 * Idempotent — only processes agents that don't yet have a knowledge entry.
 */
export function seedLegacyAgentKnowledge(db: Database.Database): void {
  const seededAgentKnowledgeEntries = seedMissingAgentKnowledgeEntriesFromLegacyMemories(db);
  if (seededAgentKnowledgeEntries > 0) {
    logger.info(`Migration: seeded ${seededAgentKnowledgeEntries} agent-owned knowledge entry/entries`);
  }
  cleanupLegacyAgentMemoriesArtifacts(db);
}

/**
 * Ensure project owners are seeded into project_members table.
 * Idempotent — uses ON CONFLICT DO UPDATE.
 */
export function seedProjectOwners(db: Database.Database): void {
  const firstAdmin = db.prepare(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1"
  ).get() as { id: string } | undefined;
  if (firstAdmin?.id) {
    const ownerSeeded = db.prepare(
      "UPDATE projects SET owner_id = ? WHERE owner_id IS NULL"
    ).run(firstAdmin.id);
    if (ownerSeeded.changes > 0) {
      logger.info(`Migration: assigned owner_id to ${ownerSeeded.changes} project(s) using first admin`);
    }
  }

  const ownedProjects = db.prepare(
    'SELECT id, owner_id FROM projects WHERE owner_id IS NOT NULL'
  ).all() as Array<{ id: string; owner_id: string }>;
  const upsertOwnerMember = db.prepare(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES (?, ?, ?, 'owner')
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'owner'`
  );
  for (const project of ownedProjects) {
    upsertOwnerMember.run(randomUUID(), project.id, project.owner_id);
  }
}

/**
 * Seed builtin project templates if none exist.
 * Idempotent — checks count before inserting.
 */
export function seedBuiltinProjectTemplates(db: Database.Database): void {
  const templateCount = (db.prepare('SELECT COUNT(*) as c FROM project_templates WHERE is_builtin = 1').get() as any).c;
  if (templateCount === 0) {
    const builtinTemplates = [
      {
        id: 'tpl-bugfix',
        name: 'Bug修复流程',
        description: '标准bug修复流程：复现 → 定位 → 修复 → 回归测试',
        template_data: JSON.stringify({
          agents: [
            { name: 'dev', role: '开发Agent。负责定位和修复bug。' },
            { name: 'test', role: '测试Agent。负责复现bug和回归测试。' },
          ],
          issues: [
            { title: '复现bug', assigned_to_role: 'test', body: '复现bug，记录复现步骤和环境信息。' },
            { title: '定位根因', assigned_to_role: 'dev', body: '分析代码定位bug根因。' },
            { title: '修复实现', assigned_to_role: 'dev', body: '编写修复代码并通过编译。' },
            { title: '回归测试', assigned_to_role: 'test', body: '验证修复是否生效，确认无回归问题。' },
          ],
        }),
      },
      {
        id: 'tpl-feature',
        name: '功能开发流程',
        description: '完整功能开发流程：需求分析 → 技术设计 → 实现 → 测试',
        template_data: JSON.stringify({
          agents: [
            { name: 'product', role: '产品Agent。负责需求分析和产品规划。' },
            { name: 'dev', role: '开发Agent。负责技术设计和代码实现。' },
            { name: 'test', role: '测试Agent。负责编写测试用例和质量保障。' },
          ],
          issues: [
            { title: '需求分析', assigned_to_role: 'product', body: '分析功能需求，输出需求文档。' },
            { title: '技术设计', assigned_to_role: 'dev', body: '基于需求文档进行技术方案设计。' },
            { title: '代码实现', assigned_to_role: 'dev', body: '按技术方案编写代码实现功能。' },
            { title: '测试验证', assigned_to_role: 'test', body: '编写和运行测试用例，验证功能正确性。' },
          ],
        }),
      },
      {
        id: 'tpl-review',
        name: '代码审查流程',
        description: '代码审查流程：阅读代码 → 发现问题 → 出审查报告',
        template_data: JSON.stringify({
          agents: [
            { name: 'reviewer', role: '代码审查Agent。阅读和审查代码，发现潜在问题。' },
            { name: 'dev', role: '开发Agent。根据审查意见修复代码问题。' },
          ],
          issues: [
            { title: '阅读代码', assigned_to_role: 'reviewer', body: '阅读指定代码范围，理解逻辑和结构。' },
            { title: '发现问题', assigned_to_role: 'reviewer', body: '记录发现的代码问题、风格问题和潜在bug。' },
            { title: '输出审查报告', assigned_to_role: 'reviewer', body: '汇总所有问题，输出结构化审查报告。' },
          ],
        }),
      },
    ];

    const insertStmt = db.prepare(
      'INSERT INTO project_templates (id, name, description, template_data, created_by, is_builtin) VALUES (?, ?, ?, ?, ?, 1)'
    );
    for (const t of builtinTemplates) {
      insertStmt.run(t.id, t.name, t.description, t.template_data, 'system');
    }
    logger.info(`Migration: seeded ${builtinTemplates.length} builtin project templates`);
  }
}
