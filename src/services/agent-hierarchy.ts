import Database from 'better-sqlite3';
import { Agent } from '../types';

export type HierarchyAgent = Pick<Agent, 'id' | 'project_id' | 'name' | 'is_controller' | 'parent_agent_id'>;

export interface ParentAgentValidationResult {
  parentAgent: HierarchyAgent | null;
  error: string | null;
}

export function loadProjectHierarchyAgents(db: Database.Database, projectId: string): HierarchyAgent[] {
  return db.prepare(
    'SELECT id, project_id, name, is_controller, parent_agent_id FROM agents WHERE project_id = ?'
  ).all(projectId) as HierarchyAgent[];
}

export function getDirectChildAgents(agents: HierarchyAgent[], agentId: string): HierarchyAgent[] {
  return agents.filter((agent) => agent.parent_agent_id === agentId);
}

export function getDirectChildIds(agents: HierarchyAgent[], agentId: string): string[] {
  return getDirectChildAgents(agents, agentId).map((agent) => agent.id);
}

export function wouldCreateHierarchyCycle(
  agents: HierarchyAgent[],
  agentId: string,
  candidateParentId: string
): boolean {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const visited = new Set<string>();
  let currentId: string | null = candidateParentId;

  while (currentId && !visited.has(currentId)) {
    if (currentId === agentId) return true;
    visited.add(currentId);
    currentId = byId.get(currentId)?.parent_agent_id || null;
  }

  return false;
}

export function validateParentAgentAssignment(
  db: Database.Database,
  projectId: string,
  parentAgentId?: string | null,
  agentId?: string
): ParentAgentValidationResult {
  const normalizedParentId = typeof parentAgentId === 'string' ? parentAgentId.trim() : parentAgentId;
  if (!normalizedParentId) {
    return { parentAgent: null, error: null };
  }

  const agents = loadProjectHierarchyAgents(db, projectId);
  const parentAgent = agents.find((agent) => agent.id === normalizedParentId) || null;
  if (!parentAgent) {
    return { parentAgent: null, error: 'Parent agent must belong to the same project' };
  }

  if (agentId && parentAgent.id === agentId) {
    return { parentAgent: null, error: 'Agent cannot be its own parent' };
  }

  if (agentId && wouldCreateHierarchyCycle(agents, agentId, parentAgent.id)) {
    return { parentAgent: null, error: 'Parent agent cannot be a descendant of this agent' };
  }

  return { parentAgent, error: null };
}

export function canMessageDirectHierarchyOnly(
  db: Database.Database,
  fromAgent: Pick<Agent, 'id' | 'project_id' | 'is_controller' | 'parent_agent_id'>,
  toAgentId: string
): boolean {
  if (fromAgent.is_controller || !fromAgent.parent_agent_id) {
    return true;
  }

  const agents = loadProjectHierarchyAgents(db, fromAgent.project_id);
  if (fromAgent.parent_agent_id === toAgentId) {
    return true;
  }

  return getDirectChildIds(agents, fromAgent.id).includes(toAgentId);
}
