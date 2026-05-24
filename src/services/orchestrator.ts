import { Agent, OrchestratorEngine, Project } from '../types';
import { config } from '../config';
import { getDatabase } from '../db/database';
import logger from '../logger';
import { runControllerWithLangGraph } from './langgraph-runner';
import { applyControllerBackoff, buildControllerActivitySnapshot } from './controller-backoff';
import { createAgentTask } from './tasks';

export interface ControllerOrchestrationInput {
  project: Project;
  controller: Agent;
  taskPrompt: string;
  triggerIssueNumber?: number;
  activitySnapshot?: string;
}

interface OrchestrationRunRecordInput {
  engine: OrchestratorEngine;
  decision: string;
  controllerAgentId?: string;
  controllerStarted: boolean;
  controllerRunId?: string;
  controllerPid?: number;
  dispatchCount: number;
  dispatchSummary: string;
  reasons: string[];
  actions: unknown[];
  dispatchResults: unknown[];
  backoffMs?: number;
  backoffReason?: string;
  backoffLabel?: string;
}

const CONTROLLER_ERROR_BACKOFF_MS = 15 * 60 * 1000;

function normalizeEngine(value: unknown): OrchestratorEngine {
  return String(value || '').toLowerCase() === 'native' ? 'native' : 'langgraph';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value || []);
  } catch {
    return '[]';
  }
}

function combineOrchestrationReasons(
  controllerReasons: string[],
  idleReasons: string[] = [],
  backoffLabel?: string,
  backoffReason?: string
): string[] {
  const reasons = [...controllerReasons];
  for (const reason of idleReasons.filter(Boolean)) {
    reasons.push('idle: ' + reason);
  }
  if (backoffLabel && backoffReason) {
    reasons.push('backoff ' + backoffLabel + ': ' + backoffReason);
  }
  return reasons;
}

function recordOrchestrationRun(projectId: string, input: OrchestrationRunRecordInput): void {
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO orchestration_runs (
        project_id,
        engine,
        decision,
        controller_agent_id,
        controller_started,
        controller_run_id,
        controller_pid,
        dispatch_count,
        dispatch_summary,
        reasons,
        backoff_ms,
        backoff_reason,
        backoff_label,
        actions,
        dispatch_results
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      projectId,
      input.engine,
      input.decision,
      input.controllerAgentId || null,
      input.controllerStarted ? 1 : 0,
      input.controllerRunId || null,
      input.controllerPid ?? null,
      input.dispatchCount,
      input.dispatchSummary || '',
      safeJson(input.reasons),
      input.backoffMs ?? 0,
      input.backoffReason || '',
      input.backoffLabel || '',
      safeJson(input.actions),
      safeJson(input.dispatchResults)
    );
  } catch (err) {
    logger.warn({ err, projectId }, 'orchestration.record_failed');
  }
}

function startNativeController(input: ControllerOrchestrationInput): void {
  const { project, controller, taskPrompt } = input;
  const task = createAgentTask(controller.id, {
    source: 'controller-orchestration',
    source_ref: null,
    task_type: 'controller',
    reason: input.triggerIssueNumber
      ? `Native controller orchestration for issue #${input.triggerIssueNumber}`
      : 'Native controller orchestration',
    prompt: taskPrompt,
    priority: 20,
    metadata: {
      engine: 'native',
      trigger_issue_number: input.triggerIssueNumber ?? null,
      activity_snapshot: input.activitySnapshot || '',
    },
    dedupe_key: [
      'controller',
      project.id,
      controller.id,
      input.triggerIssueNumber ?? 'project',
    ].join(':'),
  });
  recordOrchestrationRun(project.id, {
    engine: 'native',
    decision: 'execute_controller',
    controllerAgentId: controller.id,
    controllerStarted: true,
    controllerRunId: undefined,
    controllerPid: undefined,
    dispatchCount: 0,
    dispatchSummary: `native controller task queued: ${task.id}`,
    reasons: ['Native engine queued a controller Task'],
    actions: [],
    dispatchResults: [{ agentId: controller.id, started: true, message: 'controller task queued', taskId: task.id }],
    backoffMs: 0,
    backoffReason: '',
    backoffLabel: '',
  });
}

function startLangGraphController(input: ControllerOrchestrationInput): void {
  logger.info({
    projectId: input.project.id,
    controllerAgentId: input.controller.id,
  }, 'langgraph.controller.triggered');

  void runControllerWithLangGraph(input)
    .then((result) => {
      if (!result.controllerStarted && result.backoffMs > 0 && result.backoffLabel) {
        const snapshot = input.activitySnapshot || buildControllerActivitySnapshot(input.project.id);
        const source = result.backoffLabel === 'waiting_user' ? 'waiting_user' : 'idle';
        applyControllerBackoff(input.project.id, {
          source,
          snapshot,
          ms: result.backoffMs,
          reason: result.backoffReason || result.idleReasons.join('; ') || 'No controller work needed',
          label: result.backoffLabel,
        });
      }

      const reasons = combineOrchestrationReasons(
        result.controllerReasons,
        result.idleReasons,
        result.backoffLabel,
        result.backoffReason
      );
      recordOrchestrationRun(input.project.id, {
        engine: 'langgraph',
        decision: result.decision,
        controllerAgentId: input.controller.id,
        controllerStarted: result.controllerStarted,
        controllerRunId: result.runId,
        controllerPid: result.pid,
        dispatchCount: result.dispatchCount,
        dispatchSummary: result.dispatchSummary,
        reasons,
        actions: result.actions,
        dispatchResults: result.dispatchResults,
        backoffMs: result.backoffMs,
        backoffReason: result.backoffReason,
        backoffLabel: result.backoffLabel || '',
      });

      if (result.controllerStarted) {
        logger.info({
          projectId: input.project.id,
          controllerAgentId: input.controller.id,
          runId: result.runId,
          pid: result.pid,
          taskId: result.controllerTaskId,
          decision: result.decision,
          dispatchCount: result.dispatchCount,
        }, 'langgraph.controller.task_created');
        return;
      }

      const reasonText = reasons.length > 0 ? reasons.join('; ') : 'none';
      const backoffText = result.backoffLabel
        ? `, backoff=${result.backoffLabel}(${Math.round(result.backoffMs / 60000)}m)`
        : '';
      logger.debug({
        projectId: input.project.id,
        decision: result.decision,
        dispatchCount: result.dispatchCount,
        reasons: reasonText,
        backoffLabel: result.backoffLabel || '',
        backoffText,
      }, 'langgraph.controller.not_started');
    })
    .catch((err) => {
      const errorMessage = err?.message || String(err);
      const snapshot = input.activitySnapshot || buildControllerActivitySnapshot(input.project.id);
      const backoffLabel = err?.code === 'E2BIG' ? 'spawn_e2big' : 'controller_error';
      applyControllerBackoff(input.project.id, {
        source: 'controller_error',
        snapshot,
        ms: CONTROLLER_ERROR_BACKOFF_MS,
        reason: errorMessage,
        label: backoffLabel,
      });
      recordOrchestrationRun(input.project.id, {
        engine: 'langgraph',
        decision: 'error',
        controllerAgentId: input.controller.id,
        controllerStarted: false,
        dispatchCount: 0,
        dispatchSummary: 'langgraph execution failed',
        reasons: combineOrchestrationReasons([errorMessage], [], backoffLabel, errorMessage),
        actions: [],
        dispatchResults: [],
        backoffMs: CONTROLLER_ERROR_BACKOFF_MS,
        backoffReason: errorMessage,
        backoffLabel,
      });
      logger.error({
        err,
        projectId: input.project.id,
        controllerAgentId: input.controller.id,
        backoffLabel,
      }, 'langgraph.controller.failed');
    });
}

export function startControllerOrchestration(input: ControllerOrchestrationInput): void {
  const projectEngineRaw = (input.project as any).orchestrator_engine;
  const engine = (projectEngineRaw === undefined || projectEngineRaw === null || projectEngineRaw === '')
    ? normalizeEngine(config.defaultOrchestratorEngine)
    : normalizeEngine(projectEngineRaw);

  if (engine === 'langgraph') {
    startLangGraphController(input);
    return;
  }

  startNativeController(input);
}
