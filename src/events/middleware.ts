import type { DomainEvent, EventMiddleware } from './types';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger';
import { appendEvent } from './store';
import { config } from '../config';

export const correlationMiddleware: EventMiddleware = (event, next) => {
  if (!event.meta.correlationId) {
    event.meta.correlationId = uuidv4();
  }
  next();
};

export const loggingMiddleware: EventMiddleware = (event, next) => {
  logger.debug({
    eventType: event.type,
    projectId: event.projectId,
    correlationId: event.meta.correlationId,
    source: event.meta.source,
  }, 'event.published');
  next();
};

export const persistenceMiddleware: EventMiddleware = (event, next) => {
  if (config.eventLogEnabled) {
    try {
      appendEvent(event);
    } catch (err) {
      logger.warn({ err, eventType: event.type }, 'event.persist_failed');
    }
  }
  next();
};
