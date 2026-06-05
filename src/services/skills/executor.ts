import { getDatabase } from '../../db/database';
import { getSkill, parseCapabilities } from './registry';
import type { SkillTriggerContext, SkillTriggerResult } from './types';

/**
 * Execute a trigger skill for all agents in a project that have it.
 * Called by event subscribers as a replacement for hardcoded automation logic.
 *
 * @returns array of results from agents that were activated
 */
export function executeSkillTrigger(
  skillId: string,
  ctx: SkillTriggerContext
): SkillTriggerResult[] {
  const db = getDatabase();
  const agents = db.prepare(
    'SELECT id, capabilities_json FROM agents WHERE project_id = ?'
  ).all(ctx.projectId) as Array<{ id: string; capabilities_json: string }>;

  const results: SkillTriggerResult[] = [];

  for (const agent of agents) {
    const skills = parseCapabilities(agent.capabilities_json);
    if (!skills.includes(skillId)) continue;

    const skill = getSkill(skillId);
    if (!skill?.triggerHandler) continue;

    // Inject the agentId so the handler knows which agent this is for
    const enrichedCtx: SkillTriggerContext = {
      ...ctx,
      payload: { ...ctx.payload, agentId: agent.id },
    };

    const result = skill.triggerHandler(enrichedCtx);
    // triggerHandler may be sync or async
    if (result instanceof Promise) {
      // For now, trigger handlers are synchronous.
      // If async handlers are needed, this function should become async too.
      continue;
    }
    results.push(result);
  }

  return results;
}
