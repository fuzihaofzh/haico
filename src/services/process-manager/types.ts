import { Agent } from '../../types';

export type OnAgentFinishCallback = (agent: Agent, exitCode: number | null) => void;

export type AgentExitStatus = 'idle' | 'error' | 'stopped';

export type ProcessOutputStream = 'stdout' | 'stderr';

