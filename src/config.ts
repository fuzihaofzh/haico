import path from 'path';

function normalizeOrchestratorEngine(value: string | undefined): 'native' | 'langgraph' {
  return value?.toLowerCase() === 'native' ? 'native' : 'langgraph';
}

export const config = {
  port: parseInt(process.env.AGENTOPIA_PORT || '4567', 10),
  host: process.env.AGENTOPIA_HOST || '0.0.0.0',
  dbPath: process.env.AGENTOPIA_DB_PATH || path.join(process.cwd(), 'agentopia.db'),
  defaultCommandTemplate: 'cld',
  defaultOrchestratorEngine: normalizeOrchestratorEngine(process.env.AGENTOPIA_ORCHESTRATOR_ENGINE),
  logRetentionDays: 30,
};
