import { EventEmitter } from 'events';
import type { DomainEvent, EventMiddleware } from './types';
import logger from '../logger';

export class DomainEventBus {
  private emitter = new EventEmitter();
  private middlewares: EventMiddleware[] = [];

  use(middleware: EventMiddleware): void {
    this.middlewares.push(middleware);
  }

  publish(type: string, event: DomainEvent): void {
    let index = 0;
    const next = () => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++];
        mw(event, next);
      } else {
        this.dispatch(event);
      }
    };
    next();
  }

  subscribe(eventType: string, handler: (event: DomainEvent) => void): () => void {
    const wrappedHandler = (event: DomainEvent) => {
      try {
        handler(event);
      } catch (err) {
        logger.error({
          err,
          eventType: event.type,
          correlationId: event.meta.correlationId,
          handlerName: handler.name || 'anonymous',
        }, 'event.subscriber_error');
      }
    };
    this.emitter.on(eventType, wrappedHandler);
    return () => this.emitter.off(eventType, wrappedHandler);
  }

  subscribeAll(handler: (event: DomainEvent) => void): () => void {
    this.emitter.on('__all__', handler);
    return () => this.emitter.off('__all__', handler);
  }

  listenerCount(eventType: string): number {
    return this.emitter.listenerCount(eventType);
  }

  private dispatch(event: DomainEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit('__all__', event);
  }
}

export const eventBus = new DomainEventBus();
