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

export interface AgentStatusChangedEvent extends DomainEvent<
  'agent.status_changed',
  {
    agentId: string;
    status: string;
    paused?: boolean;
    taskId?: string;
    taskRunId?: string;
  }
> {}

export interface AgentCreatedEvent extends DomainEvent<
  'agent.created',
  {
    agentId: string;
    agentName: string;
    projectId: string;
    isController: boolean;
  }
> {}

export interface AgentDeletedEvent extends DomainEvent<
  'agent.deleted',
  {
    agentId: string;
    agentName: string;
    hadActiveTask: boolean;
  }
> {}

export interface AgentMessageSentEvent extends DomainEvent<
  'agent.message_sent',
  {
    message: any;
    fromAgentName: string;
    toAgentName: string;
  }
> {}

export interface AgentMessageUpdatedEvent extends DomainEvent<
  'agent.message_updated',
  {
    message: any;
    status: string;
  }
> {}

export interface SummaryCreatedEvent extends DomainEvent<
  'summary.created',
  { summary: any }
> {}

export interface SummaryUpdatedEvent extends DomainEvent<
  'summary.updated',
  { summary: any }
> {}

export interface SummaryDeletedEvent extends DomainEvent<
  'summary.deleted',
  { summaryId: string }
> {}

export interface SummaryBlockUpdatedEvent extends DomainEvent<
  'summary.block_updated',
  { summaryId: string; block: any }
> {}

export interface SummaryGeneratedEvent extends DomainEvent<
  'summary.generated',
  { summary: any }
> {}

export interface SummaryFinalizedEvent extends DomainEvent<
  'summary.finalized',
  { summary: any }
> {}

export interface TaskRequestedEvent extends DomainEvent<
  'task.requested',
  {
    taskId: string;
    agentId: string;
    source: string;
    sourceRef: string | null;
    taskType: string;
    reason: string;
    prompt: string;
    priority: number;
    metadata: Record<string, unknown>;
    dedupeKey: string | null;
    forceNewSession: boolean;
    scheduledAt: string | null;
    auditComment?: {
      issueId: string;
      body: string;
    };
  }
> {}

export interface ControllerTriggerRequestedEvent extends DomainEvent<
  'controller.trigger_requested',
  {
    triggerIssueNumber?: number;
    priority: 'urgent' | 'normal';
    reason: string;
    actorId?: string;
  }
> {}

export interface ProjectDeletedEvent extends DomainEvent<
  'project.deleted',
  {
    agentIds: string[];
  }
> {}

export type HaicoDomainEvent =
  | IssueCreatedEvent
  | IssueUpdatedEvent
  | IssueDeletedEvent
  | CommentAddedEvent
  | IssueRelationChangedEvent
  | TaskCompletedEvent
  | SchedulerTickEvent
  | AgentStatusChangedEvent
  | AgentCreatedEvent
  | AgentDeletedEvent
  | AgentMessageSentEvent
  | AgentMessageUpdatedEvent
  | SummaryCreatedEvent
  | SummaryUpdatedEvent
  | SummaryDeletedEvent
  | SummaryBlockUpdatedEvent
  | SummaryGeneratedEvent
  | SummaryFinalizedEvent
  | TaskRequestedEvent
  | ControllerTriggerRequestedEvent
  | ProjectDeletedEvent;

export interface HaicoEventMap {
  'issue.created': IssueCreatedEvent;
  'issue.updated': IssueUpdatedEvent;
  'issue.deleted': IssueDeletedEvent;
  'comment.added': CommentAddedEvent;
  'issue.relation_changed': IssueRelationChangedEvent;
  'task.completed': TaskCompletedEvent;
  'scheduler.tick': SchedulerTickEvent;
  'agent.status_changed': AgentStatusChangedEvent;
  'agent.created': AgentCreatedEvent;
  'agent.deleted': AgentDeletedEvent;
  'agent.message_sent': AgentMessageSentEvent;
  'agent.message_updated': AgentMessageUpdatedEvent;
  'summary.created': SummaryCreatedEvent;
  'summary.updated': SummaryUpdatedEvent;
  'summary.deleted': SummaryDeletedEvent;
  'summary.block_updated': SummaryBlockUpdatedEvent;
  'summary.generated': SummaryGeneratedEvent;
  'summary.finalized': SummaryFinalizedEvent;
  'task.requested': TaskRequestedEvent;
  'controller.trigger_requested': ControllerTriggerRequestedEvent;
  'project.deleted': ProjectDeletedEvent;
}
