import path from 'path';

export const config = {
  port: parseInt(process.env.ARGUS_PORT || '4567', 10),
  host: process.env.ARGUS_HOST || '0.0.0.0',
  dbPath: process.env.ARGUS_DB_PATH || path.join(__dirname, '..', 'data', 'argus.db'),
  defaultCommandTemplate: 'cld',
  defaultControllerInterval: 5,
  logRetentionDays: 30,
};
