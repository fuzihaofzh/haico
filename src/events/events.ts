import type { DomainEvent } from './types';

export interface IssueCreatedEvent extends DomainEvent<
  'issue.created',
  {
    issueId: string;
    issueNumber: number;
    title: string;
    createdBy: string;
    assignedTo: string | null;
    body?: string;
    parentId?: string;
    parentUpdated?: boolean;
  }
> {}

export interface IssueUpdatedEvent extends DomainEvent<
  'issue.updated',
  {
    issueId: string;
    issueNumber: number;
    changes: Record<string, { from: unknown; to: unknown }>;
    actor: string;
    parentCompletion?: {
      parentIssueId: string;
      parentIssueNumber: number;
      childCount: number;
    };
    refreshedParentId?: string;
    returnedToUser?: boolean;
  }
> {}

export interface IssueDeletedEvent extends DomainEvent<
  'issue.deleted',
  { issueId: string; issueNumber: number }
> {}

export interface CommentAddedEvent extends DomainEvent<
  'comment.added',
  {
    issueId: string;
    issueNumber: number;
    issueTitle: string;
    commentId: string;
    authorId: string;
    body: string;
    issueStatus: string;
    assignedTo: string | null;
  }
> {}

export interface IssueRelationChangedEvent extends DomainEvent<
  'issue.relation_changed',
  {
    sourceIssueId: string;
    sourceIssueNumber: number;
    targetIssueId: string;
    targetIssueNumber: number;
    relationType: string;
    action: 'created' | 'deleted';
  }
> {}

export interface TaskCompletedEvent extends DomainEvent<
  'task.completed',
  {
    taskId: string;
    taskRunId: string;
    agentId: string;
    taskType: string;
    status: 'completed' | 'failed' | 'cancelled';
    issueNumbers: number[];
  }
> {}

export interface SchedulerTickEvent extends DomainEvent<
  'scheduler.tick',
  { tickType: 'taskRuntime' | 'issueRecovery' }
> {}

export type HaicoDomainEvent =
  | IssueCreatedEvent
  | IssueUpdatedEvent
  | IssueDeletedEvent
  | CommentAddedEvent
  | IssueRelationChangedEvent
  | TaskCompletedEvent
  | SchedulerTickEvent;

export interface HaicoEventMap {
  'issue.created': IssueCreatedEvent;
  'issue.updated': IssueUpdatedEvent;
  'issue.deleted': IssueDeletedEvent;
  'comment.added': CommentAddedEvent;
  'issue.relation_changed': IssueRelationChangedEvent;
  'task.completed': TaskCompletedEvent;
  'scheduler.tick': SchedulerTickEvent;
}
