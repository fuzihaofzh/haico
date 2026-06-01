import { eventBus } from '../bus';
import { coalesce } from '../coalescing';
import type { DomainEvent } from '../types';
import type { IssueUpdatedEvent, TaskCompletedEvent, ControllerTriggerRequestedEvent } from '../events';
import { triggerControllerAgent } from '../../services/controller';
import { getDatabase } from '../../db/database';

const COALESCE_URGENT_MS = 3_000;
const COALESCE_NORMAL_MS = 60_000;
const MIN_CONTROLLER_INTERVAL_MS = 300_000;

function determineUrgency(event: DomainEvent): 'urgent' | 'normal' {
  if (event.type === 'controller.trigger_requested') {
    const p = event.payload as ControllerTriggerRequestedEvent['payload'];
    return p.priority;
  }
  const payload = event.payload as Record<string, unknown>;
  const actor = payload.actor || payload.createdBy || payload.authorId;
  if (actor === 'user' || actor === 'system') return 'urgent';
  if (event.type === 'issue.created' && payload.createdBy === 'user'
      && (!payload.assignedTo || payload.assignedTo === 'all')) return 'urgent';
  return 'normal';
}

function getTriggerIssueNumber(event: DomainEvent): number | undefined {
  if (event.type === 'controller.trigger_requested') {
    const p = event.payload as ControllerTriggerRequestedEvent['payload'];
    return p.triggerIssueNumber;
  }
  const payload = event.payload as Record<string, unknown>;
  if (event.type === 'issue.updated') {
    const p = payload as IssueUpdatedEvent['payload'];
    if (p.parentCompletion?.parentIssueNumber) {
      return p.parentCompletion.parentIssueNumber;
    }
  }
  return (payload.issueNumber || (payload.issueNumbers as number[] | undefined)?.[0]) as number | undefined;
}

const controllerHandler = coalesce({
  windowMs: COALESCE_URGENT_MS,
  windowFn: (mergedEvent) => determineUrgency(mergedEvent) === 'urgent' ? COALESCE_URGENT_MS : COALESCE_NORMAL_MS,
  keyFn: (event) => `controller:${event.projectId}`,
  minIntervalMs: MIN_CONTROLLER_INTERVAL_MS,
  mergeFn: (existing, incoming) => {
    const existingUrgent = determineUrgency(existing) === 'urgent';
    const incomingUrgent = determineUrgency(incoming) === 'urgent';
    return incomingUrgent && !existingUrgent ? incoming : existing;
  },
}, (event) => {
  const db = getDatabase();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(event.projectId) as any;
  if (!project || project.status === 'paused') return;

  const triggerIssueNumber = getTriggerIssueNumber(event);
  triggerControllerAgent(project, false, triggerIssueNumber);
});

export function registerControllerSubscribers(): void {
  eventBus.subscribe('issue.created', controllerHandler);
  eventBus.subscribe('issue.updated', controllerHandler);
  eventBus.subscribe('comment.added', controllerHandler);
  eventBus.subscribe('task.completed', (event) => {
    const p = event.payload as TaskCompletedEvent['payload'];
    if (p.taskType === 'issue-work' || p.taskType === 'controller') {
      controllerHandler(event);
    }
  });
  eventBus.subscribe('controller.trigger_requested', controllerHandler);
}
