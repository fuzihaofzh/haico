export interface EventMeta {
  correlationId: string;
  causationId?: string;
  timestamp: number;
  source: string;
}

export interface DomainEvent<T extends string = string, P = Record<string, unknown>> {
  type: T;
  projectId: string;
  payload: P;
  meta: EventMeta;
}

export type EventHandler<E extends DomainEvent = DomainEvent> = (event: E) => void | Promise<void>;

export interface IEventBus {
  publish<K extends string>(type: K, event: DomainEvent<K, any>): void;
  subscribe<K extends string>(eventType: K, handler: EventHandler<DomainEvent<K, any>>): () => void;
}

export type EventMiddleware = (event: DomainEvent, next: () => void) => void;
