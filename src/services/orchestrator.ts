import { Agent, OrchestratorEngine, Project } from '../types';
import { config } from '../config';
import { getDatabase } from '../db/database';
import logger from '../logger';
import { startAgentProcess } from './process-manager';
import { buildSystemPrompt } from './system-prompt';
import { runControllerWithLangGraph } from './langgraph-runner';

export interface ControllerOrchestrationInput {
  project: Project;
  controller: Agent;
  taskPrompt: string;
  triggerIssueNumber?: number;
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
}

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
        actions,
        dispatch_results
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      safeJson(input.actions),
      safeJson(input.dispatchResults)
    );
  } catch (err) {
    logger.warn(err, `Failed to record orchestration run for project ${projectId}`);
  }
}

function startNativeController(input: ControllerOrchestrationInput): void {
  const { project, controller, taskPrompt } = input;
  const commandTemplate = controller.command_template || project.command_template || config.defaultCommandTemplate;
  const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
  const systemPrompt = isRawShell ? undefined : buildSystemPrompt(controller, project);

  const run = startAgentProcess(controller, taskPrompt, commandTemplate, systemPrompt);
  recordOrchestrationRun(project.id, {
    engine: 'native',
    decision: 'execute_controller',
    controllerAgentId: controller.id,
    controllerStarted: true,
    controllerRunId: run.runId,
    controllerPid: run.pid,
    dispatchCount: 0,
    dispatchSummary: 'native controller launch',
    reasons: ['Native engine directly starts controller'],
    actions: [],
    dispatchResults: [],
  });
}

function startLangGraphController(input: ControllerOrchestrationInput): void {
  logger.info(`Triggering controller via langgraph for project "${input.project.name}"`);

  void runControllerWithLangGraph(input)
    .then((result) => {
      recordOrchestrationRun(input.project.id, {
        engine: 'langgraph',
        decision: result.decision,
        controllerAgentId: input.controller.id,
        controllerStarted: result.controllerStarted,
        controllerRunId: result.runId,
        controllerPid: result.pid,
        dispatchCount: result.dispatchCount,
        dispatchSummary: result.dispatchSummary,
        reasons: result.controllerReasons,
        actions: result.actions,
        dispatchResults: result.dispatchResults,
      });

      if (result.controllerStarted) {
        logger.info(
          `LangGraph controller run created (project=${input.project.id}, agent=${input.controller.id}, runId=${result.runId}, pid=${result.pid}, decision=${result.decision}, dispatched=${result.dispatchCount})`
        );
        return;
      }

      const reasons = result.controllerReasons.length > 0 ? result.controllerReasons.join('; ') : 'none';
      logger.info(
        `LangGraph orchestration finished without controller start (project=${input.project.id}, decision=${result.decision}, dispatched=${result.dispatchCount}, reasons=${reasons})`
      );
    })
    .catch((err) => {
      recordOrchestrationRun(input.project.id, {
        engine: 'langgraph',
        decision: 'error',
        controllerAgentId: input.controller.id,
        controllerStarted: false,
        dispatchCount: 0,
        dispatchSummary: 'langgraph execution failed',
        reasons: [err?.message || String(err)],
        actions: [],
        dispatchResults: [],
      });
      logger.error(err, `LangGraph controller run failed for project ${input.project.id}`);
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
