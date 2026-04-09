import { Agent, CommandProfile, Issue, Project } from '../types';
import { config } from '../config';
import { getDatabase } from '../db/database';
import { resolveCommandType } from './command-profiles';
import logger from '../logger';

/**
 * Model Tier Router — dynamically selects command_template per dispatch
 * based on issue complexity and command_profiles intelligence scores.
 *
 * Intelligence scoring:
 *   - Each command_profile has an `intelligence` field (1-10, user-defined)
 *   - Each issue has `priority` (higher = more important/complex)
 *   - Labels can carry complexity hints (e.g. "arch", "refactor", "doc", "typo")
 *
 * Routing logic:
 *   1. Compute a "required intelligence" score from the issues
 *   2. Pick the cheapest profile whose intelligence >= required
 */

// Label keywords that bump complexity up or down
const HIGH_COMPLEXITY_LABELS = ['arch', 'architecture', 'refactor', 'security', 'design', 'complex', 'perf', 'performance'];
const LOW_COMPLEXITY_LABELS = ['doc', 'docs', 'typo', 'format', 'i18n', 'translate', 'style', 'chore', 'trivial'];

function computeRequiredIntelligence(issues: Issue[]): number {
  if (issues.length === 0) return 5;

  let maxScore = 0;
  for (const issue of issues) {
    // Base score from priority (1-10 maps roughly to intelligence 1-10)
    let score = Math.min(10, Math.max(1, issue.priority));

    // Label adjustments
    const labels = (issue.labels || '').toLowerCase().split(',').map(l => l.trim()).filter(Boolean);
    if (labels.some(l => HIGH_COMPLEXITY_LABELS.includes(l))) {
      score = Math.min(10, score + 2);
    }
    if (labels.some(l => LOW_COMPLEXITY_LABELS.includes(l))) {
      score = Math.max(1, score - 2);
    }

    maxScore = Math.max(maxScore, score);
  }

  return maxScore;
}

function loadProjectProfiles(projectId: string): CommandProfile[] {
  const db = getDatabase();
  // Load all command profiles (they are global, not per-project)
  return db.prepare(
    'SELECT id, name, command, type, intelligence, created_at, updated_at FROM command_profiles ORDER BY intelligence ASC, name ASC'
  ).all() as CommandProfile[];
}

/**
 * Given issues and available profiles, pick the best-matching profile.
 * Strategy: pick the cheapest (lowest intelligence) profile that still
 * meets the required intelligence threshold.
 */
function selectProfile(profiles: CommandProfile[], requiredIntelligence: number): CommandProfile | null {
  if (profiles.length === 0) return null;

  // Find the cheapest profile that meets the requirement
  for (const profile of profiles) {
    if (profile.intelligence >= requiredIntelligence) {
      return profile;
    }
  }

  // No profile meets the requirement — use the most intelligent one available
  return profiles[profiles.length - 1];
}

export interface ModelTierRouteResult {
  commandTemplate: string;
  commandType: ReturnType<typeof resolveCommandType>;
  profileId: string | null;
  profileName: string | null;
  requiredIntelligence: number;
  selectedIntelligence: number;
  routed: boolean;  // true if dynamic routing was used, false if fallback
}

/**
 * Resolve the command template for a dispatch, using dynamic model tier
 * routing when the agent's model_tier_policy is 'auto'.
 */
export function resolveDispatchCommand(
  agent: Agent,
  issues: Issue[],
  project: Project
): ModelTierRouteResult {
  const fallbackCommand = agent.command_template || project.command_template || config.defaultCommandTemplate;
  const fallbackType = resolveCommandType(agent.command_type || project.command_type, fallbackCommand);

  // If policy is 'fixed', use the agent's own command (backward compatible)
  if (agent.model_tier_policy !== 'auto') {
    return {
      commandTemplate: fallbackCommand,
      commandType: fallbackType,
      profileId: null,
      profileName: null,
      requiredIntelligence: 0,
      selectedIntelligence: 0,
      routed: false,
    };
  }

  // Dynamic routing
  const profiles = loadProjectProfiles(project.id);
  if (profiles.length === 0) {
    logger.warn('Model tier routing enabled for agent %s but no command profiles exist, using fallback', agent.id);
    return {
      commandTemplate: fallbackCommand,
      commandType: fallbackType,
      profileId: null,
      profileName: null,
      requiredIntelligence: 0,
      selectedIntelligence: 0,
      routed: false,
    };
  }

  const requiredIntelligence = computeRequiredIntelligence(issues);
  const selected = selectProfile(profiles, requiredIntelligence);

  if (!selected) {
    return {
      commandTemplate: fallbackCommand,
      commandType: fallbackType,
      profileId: null,
      profileName: null,
      requiredIntelligence,
      selectedIntelligence: 0,
      routed: false,
    };
  }

  const commandType = resolveCommandType(selected.type, selected.command);

  logger.info(
    'Model tier router: agent=%s required=%d selected=%s (intelligence=%d, command=%s)',
    agent.id, requiredIntelligence, selected.name, selected.intelligence, selected.command
  );

  return {
    commandTemplate: selected.command,
    commandType,
    profileId: selected.id,
    profileName: selected.name,
    requiredIntelligence,
    selectedIntelligence: selected.intelligence,
    routed: true,
  };
}
