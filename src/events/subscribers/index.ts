import { eventBus } from '../bus';
import { correlationMiddleware, loggingMiddleware, persistenceMiddleware } from '../middleware';
import { registerRealtimeSubscribers } from './realtime-subscriber';
import { registerControllerSubscribers } from './controller-subscriber';
import { registerAgentSubscribers } from './agent-subscriber';
import { registerTaskSubscribers } from './task-subscriber';
import { registerTaskCreationSubscribers } from './task-creation-subscriber';

export function registerAllSubscribers(): void {
  eventBus.use(correlationMiddleware);
  eventBus.use(loggingMiddleware);
  eventBus.use(persistenceMiddleware);

  registerRealtimeSubscribers();
  registerControllerSubscribers();
  registerAgentSubscribers();
  registerTaskSubscribers();
  registerTaskCreationSubscribers();
}
