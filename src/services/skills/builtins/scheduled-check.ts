import type { SkillDefinition, SkillTriggerContext, SkillTriggerResult } from '../types';
import { getDatabase } from '../../../db/database';
import { startAgent } from '../../agents/lifecycle';
import { AgentPausedError } from '../../agents/errors';
import { parseCapabilities, getSkill } from '../registry';
import type { Agent } from '../../../types';

/**
 * Scheduled-check trigger skill.
 * Agents with this skill are periodically activated by the scheduler
 * to check project status and report findings.
 *
 * This is the first skill that demonstrates a new capability
 * the system previously could not provide.
 *
 * Configuration:
 *   The skill id alone is sufficient for basic usage (1-minute interval).
 *   For custom intervals, the agent's context_json can include:
 *   { "scheduled_check_interval_seconds": 300 }
 */

const DEFAULT_INTERVAL_SECONDS = 60;

// In-memory map for tracking last check time per agent
const lastCheckTimes = new Map<string, number>();

const scheduledCheckSkill: SkillDefinition = {
  id: 'scheduled-check',
  description: '按时间间隔定期激活 agent 检查项目状态并汇报',
  memoryStrategy: 'reduce',
  promptFragment: `## Scheduled Check
你被定时激活来检查当前项目状态。每次激活时：
1. 查看项目是否有新的或未处理的 issue
2. 检查是否有需要关注的变化
3. 如果发现需要处理的事项，创建或更新相关 issue
4. 如果一切正常，简要汇报当前状态
5. 避免重复创建已存在的 issue`,

  triggerHandler(ctx: SkillTriggerContext): SkillTriggerResult {
    const { projectId, payload } = ctx;
    const agentId = payload.agentId as string;
    if (!agentId) return { shouldActivate: false };

    const db = getDatabase();
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND project_id = ?'
    ).get(agentId, projectId) as Agent | undefined;

    if (!agent || agent.paused) return { shouldActivate: false };

    // Check interval from context_json
    let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    try {
      const context = JSON.parse(agent.context_json || '{}');
      if (typeof context.scheduled_check_interval_seconds === 'number') {
        intervalSeconds = context.scheduled_check_interval_seconds;
      }
    } catch { /* use default */ }

    // Check if enough time has passed since last activation
    const now = Date.now();
    const lastCheck = lastCheckTimes.get(agent.id) || 0;
    if (now - lastCheck < intervalSeconds * 1000) {
      return { shouldActivate: false };
    }
    lastCheckTimes.set(agent.id, now);

    // Start a task for this agent
    try {
      startAgent(agent.id, {
        prompt: '定时检查：请检查项目当前状态，查看是否有需要关注的新 issue 或变化，简要汇报。',
        priority: 5,
        metadata: { source: 'scheduled-check' },
      });
    } catch (e) {
      if (e instanceof AgentPausedError) return { shouldActivate: false };
      // Agent might be already running (409) or otherwise unavailable
      return { shouldActivate: false };
    }

    return { shouldActivate: true };
  },
};

export default scheduledCheckSkill;

/**
 * Scan all agents with the scheduled-check skill and trigger those due.
 * Called by the scheduler tick.
 */
export function runScheduledCheckTick(): void {
  const db = getDatabase();
  const agents = db.prepare(
    `SELECT id, project_id, capabilities_json, paused FROM agents WHERE paused = 0`
  ).all() as Array<{ id: string; project_id: string; capabilities_json: string; paused: number }>;

  for (const agent of agents) {
    const skills = parseCapabilities(agent.capabilities_json);
    if (!skills.includes('scheduled-check')) continue;

    const skill = getSkill('scheduled-check');
    if (!skill?.triggerHandler) continue;

    skill.triggerHandler({
      projectId: agent.project_id,
      payload: { agentId: agent.id },
    });
  }
}
