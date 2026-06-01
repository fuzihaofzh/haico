import path from 'path';

function normalizeOrchestratorEngine(value: string | undefined): 'native' | 'langgraph' {
  return value?.toLowerCase() === 'native' ? 'native' : 'langgraph';
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.HAICO_PORT || '4567', 10),
  host: process.env.HAICO_HOST || '0.0.0.0',
  dbPath: process.env.HAICO_DB_PATH || path.join(process.cwd(), 'haico.db'),
  defaultCommandTemplate: 'cld',
  defaultOrchestratorEngine: normalizeOrchestratorEngine(process.env.HAICO_ORCHESTRATOR_ENGINE),
  logRetentionDays: 30,
  eventLogEnabled: process.env.HAICO_EVENT_LOG !== 'off',
};
