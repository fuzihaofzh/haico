import pino from 'pino';

const logger = pino({ name: 'haico', level: process.env.HAICO_LOG_LEVEL || 'info' });

export default logger;
