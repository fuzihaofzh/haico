import path from 'path';

function normalizeOrchestratorEngine(value: string | undefined): 'native' | 'langgraph' {
  return value?.toLowerCase() === 'native' ? 'native' : 'langgraph';
}

export const config = {
  port: parseInt(process.env.ARGUS_PORT || '4567', 10),
  host: process.env.ARGUS_HOST || '0.0.0.0',
  dbPath: process.env.ARGUS_DB_PATH || path.join(__dirname, '..', 'data', 'argus.db'),
  defaultCommandTemplate: 'cld',
  defaultOrchestratorEngine: normalizeOrchestratorEngine(process.env.ARGUS_ORCHESTRATOR_ENGINE),
  logRetentionDays: 30,
};
