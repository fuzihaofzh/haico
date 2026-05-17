import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToProject } from '../../realtime';
import {
  InvalidIssueRelationTypeError,
  IssueRelationAlreadyExistsError,
  IssueRelationNotFoundError,
  MissingIssueRelationFieldsError,
  SelfIssueRelationError,
  SourceIssueNotFoundError,
  TargetIssueNotFoundError,
  TargetIssueProjectMismatchError,
} from './errors';
import { isSqliteUniqueConstraintError } from './utils';

type IssueRelationType = 'blocks' | 'related_to';

export interface CreateIssueRelationInput {
  type?: string;
  target_issue_id?: string;
  actor?: string;
}

function getRelationOrThrow(db: Database.Database, relationId: string): any {
  const relation = db.prepare('SELECT * FROM issue_relations WHERE id = ?').get(relationId) as any;
  if (!relation) throw new IssueRelationNotFoundError();
  return relation;
}

function parseRelationType(type: string | undefined): IssueRelationType {
  if (!type) throw new MissingIssueRelationFieldsError();
  if (type !== 'blocks' && type !== 'related_to') throw new InvalidIssueRelationTypeError();
  return type;
}

export function createIssueRelation(
  db: Database.Database,
  sourceIssueId: string,
  input: CreateIssueRelationInput,
  sourceProjectId?: string
): any {
  const targetIssueId = input.target_issue_id;
  if (!input.type || !targetIssueId) throw new MissingIssueRelationFieldsError();
  const relationType = parseRelationType(input.type);
  if (sourceIssueId === targetIssueId) throw new SelfIssueRelationError();

  let fromIssue: any;
  let relId = '';
  try {
    relId = db.transaction(() => {
      const toIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(targetIssueId) as any;
      fromIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(sourceIssueId) as any;
      if (!fromIssue) throw new SourceIssueNotFoundError();
      if (!toIssue) throw new TargetIssueNotFoundError();
      if (toIssue.project_id !== fromIssue.project_id || (sourceProjectId && toIssue.project_id !== sourceProjectId)) {
        throw new TargetIssueProjectMismatchError();
      }

      const id = uuidv4();
      db.prepare(
        'INSERT INTO issue_relations (id, from_issue_id, to_issue_id, relation_type, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(id, sourceIssueId, targetIssueId, relationType, input.actor || 'user');

      const eventStmt = db.prepare(
        'INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const actorId = input.actor || 'user';
      if (relationType === 'blocks') {
        eventStmt.run(
          uuidv4(),
          sourceIssueId,
          actorId,
          `added blocks dependency on #${toIssue.number}`,
          'status_change',
          JSON.stringify({ relation: 'blocks', target: targetIssueId, target_number: toIssue.number })
        );
        eventStmt.run(
          uuidv4(),
          targetIssueId,
          actorId,
          `marked as blocked by #${fromIssue.number}`,
          'status_change',
          JSON.stringify({ relation: 'blocked_by', source: sourceIssueId, source_number: fromIssue.number })
        );
      } else {
        eventStmt.run(
          uuidv4(),
          sourceIssueId,
          actorId,
          `linked as related to #${toIssue.number}`,
          'status_change',
          JSON.stringify({ relation: 'related_to', target: targetIssueId, target_number: toIssue.number })
        );
      }

      return id;
    })();
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) throw new IssueRelationAlreadyExistsError();
    throw error;
  }

  broadcastToProject(fromIssue.project_id, {
    type: 'issue_updated',
    projectId: fromIssue.project_id,
    data: { issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(sourceIssueId) },
  });

  return getRelationOrThrow(db, relId);
}

export function deleteIssueRelation(db: Database.Database, issueId: string, relationId: string): void {
  const relation = getRelationOrThrow(db, relationId);
  if (relation.from_issue_id !== issueId && relation.to_issue_id !== issueId) {
    throw new IssueRelationNotFoundError();
  }

  db.prepare('DELETE FROM issue_relations WHERE id = ?').run(relationId);

  const fromIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(relation.from_issue_id) as any;
  if (fromIssue) {
    broadcastToProject(fromIssue.project_id, {
      type: 'issue_updated',
      projectId: fromIssue.project_id,
      data: { issue: fromIssue },
    });
  }
}

export function listIssueRelations(db: Database.Database, issueId: string): any {
  const blocks = db.prepare(`
    SELECT r.*, i.number as target_number, i.title as target_title, i.status as target_status
    FROM issue_relations r JOIN issues i ON i.id = r.to_issue_id
    WHERE r.from_issue_id = ? AND r.relation_type = 'blocks'
  `).all(issueId);

  const blocked_by = db.prepare(`
    SELECT r.*, i.number as source_number, i.title as source_title, i.status as source_status
    FROM issue_relations r JOIN issues i ON i.id = r.from_issue_id
    WHERE r.to_issue_id = ? AND r.relation_type = 'blocks'
  `).all(issueId);

  const related_to = db.prepare(`
    SELECT r.*, i.number as other_number, i.title as other_title, i.status as other_status
    FROM issue_relations r JOIN issues i ON i.id = r.to_issue_id
    WHERE r.from_issue_id = ? AND r.relation_type = 'related_to'
    UNION
    SELECT r.*, i.number as other_number, i.title as other_title, i.status as other_status
    FROM issue_relations r JOIN issues i ON i.id = r.from_issue_id
    WHERE r.to_issue_id = ? AND r.relation_type = 'related_to'
  `).all(issueId, issueId);

  const is_blocked = (blocked_by as any[]).some((relation) => !['done', 'closed'].includes(relation.source_status));

  return { blocks, blocked_by, related_to, is_blocked };
}
