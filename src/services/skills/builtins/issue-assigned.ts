import type { SkillDefinition, SkillTriggerContext, SkillTriggerResult } from '../types';
import { getDatabase } from '../../../db/database';
import { autoStartAssignedAgentForIssue } from '../../issue/automation';
import { parseCapabilities } from '../registry';

/**
 * Issue-assigned trigger skill.
 * When an issue is assigned to an agent that has this skill,
 * the agent is automatically started to work on it.
 *
 * This is the first trigger skill that replaces hardcoded subscriber logic,
 * serving as the reference implementation for future trigger skills.
 */
const issueAssignedSkill: SkillDefinition = {
  id: 'issue-assigned',
  description: '当 issue 被分配给该 agent 时自动激活',
  memoryStrategy: 'none',

  triggerHandler(ctx: SkillTriggerContext): SkillTriggerResult {
    const { projectId, payload } = ctx;
    const db = getDatabase();
    const assignedTo = payload.assignedTo as string | undefined;
    const issueNumber = payload.issueNumber as number;
    const source = payload.source as string;

    if (!assignedTo || assignedTo === 'user' || assignedTo === 'all') {
      return { shouldActivate: false };
    }

    // Check if the target agent has the issue-assigned skill
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND project_id = ?'
    ).get(assignedTo, projectId) as { capabilities_json: string } | undefined;

    if (!agent) {
      return { shouldActivate: false };
    }

    const skills = parseCapabilities(agent.capabilities_json);
    if (!skills.includes('issue-assigned')) {
      return { shouldActivate: false };
    }

    // Delegate to the existing automation function
    autoStartAssignedAgentForIssue(db, projectId, issueNumber, assignedTo, source);

    return { shouldActivate: true };
  },
};

export default issueAssignedSkill;
