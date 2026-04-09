import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Issue, Project } from '../types';
import { config } from '../config';
import { getDatabase } from '../db/database';
import logger from '../logger';
import { startAgentProcess } from './process-manager';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from './agent-issue-batch';
import { buildSystemPrompt } from './system-prompt';
import { resolveDispatchCommand } from './model-tier-router';

export interface LangGraphControllerInput {
  project: Project;
  controller: Agent;
  taskPrompt: string;
  triggerIssueNumber?: number;
  activitySnapshot?: string;
}

export interface OrchestrationWorkerAction {
  agentId: string;
  issueIds: string[];
  issueNumbers: number[];
  reason: string;
}

export interface OrchestrationDispatchResult {
  agentId: string;
  started: boolean;
  message: string;
  runId?: string;
  pid?: number;
}

export type ControllerDecision = 'execute_controller' | 'finish';
type WorkerCompletionSignal = 'continue' | 'needs_user' | 'done' | 'unknown';
type ControllerBackoffPlan = {
  ms: number;
  reason: string;
  label: 'waiting_user' | 'idle';
} | null;
type ControllerBackoffLabel = NonNullable<ControllerBackoffPlan>['label'];

interface WorkerOutcomeHint {
  agentId: string;
  signal: WorkerCompletionSignal;
  summary: string;
  excerpt: string;
  issueCount: number;
  issueIds: string[];
  issueNumbers: number[];
}

interface ReconcileNeedsUserResult {
  movedCount: number;
  idleReasons: string[];
}

const ControllerGraphState = Annotation.Root({
  project: Annotation<Project>(),
  controller: Annotation<Agent>(),
  taskPrompt: Annotation<string>(),
  issues: Annotation<Issue[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  agents: Annotation<Agent[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  workerOutcomeHints: Annotation<WorkerOutcomeHint[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  actions: Annotation<OrchestrationWorkerAction[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  dispatchResults: Annotation<OrchestrationDispatchResult[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  dispatchSummary: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  controllerReasons: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  idleReasons: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  controllerDecision: Annotation<ControllerDecision>({
    reducer: (_left, right) => right,
    default: () => 'finish',
  }),
  backoffMs: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  backoffReason: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  backoffLabel: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  triggerIssueNumber: Annotation<number | undefined>(),
  commandTemplate: Annotation<string | undefined>(),
  systemPrompt: Annotation<string | undefined>(),
  runId: Annotation<string | undefined>(),
  pid: Annotation<number | undefined>(),
});

function buildWorkerPrompt(project: Project, agent: Agent, assignedIssues: Issue[]): string {
  const issueBatch = getAgentIssueBatch(assignedIssues);

  const parts: string[] = [];
  if (agent.role) parts.push('Role: ' + agent.role);
  if (project.task_description) parts.push('Project task: ' + project.task_description);
  parts.push('You were auto-dispatched because you have ' + issueBatch.activeIssues.length + ' active assigned issue(s). Prioritize high-priority items first.');
  parts.push(buildAssignedIssuesPrompt(issueBatch, {
    bodyCharLimit: 1000,
    stopInstruction: 'Update issue status/comments while you work. Only work on the current batch in this run; when the current batch is complete, stop.',
  }));

  return parts.join('\n\n');
}

const WAITING_USER_PATTERNS = [
  /等待用户|用户确认|需用户|需要用户|待用户|请用户确认|等用户决定/i,
  /\b(wait(?:ing)? for user|need(?:s)? user|await(?:ing)? user|user decision|user confirmation|pending user|approval needed)\b/i,
];
const DONE_PATTERNS = [
  /已完成|已经完成|完成了|修复完成|处理完成|结束了|已解决|解决完成|验证通过/i,
  /\b(done|completed|fixed|resolved|all tasks finished|work complete)\b/i,
];
const CONTINUE_PATTERNS = [
  /继续执行|继续处理|下一步|继续推进|继续做|马上继续/i,
  /\b(continue|next step|proceed|keep working|follow-up)\b/i,
];
const WAITING_USER_BACKOFF_MS = 30 * 60 * 1000;
const IDLE_CONTROLLER_BACKOFF_MS = 15 * 60 * 1000;

// Track how many times a worker has been restarted after producing an 'unknown' signal.
// Key: agentId, Value: { count, lastResetMs }
const unknownRestartCounts = new Map<string, { count: number; lastResetMs: number }>();
const MAX_UNKNOWN_RESTARTS = 3;
const UNKNOWN_RESTART_WINDOW_MS = 2 * 60 * 60 * 1000; // reset counter after 2 hours

function getUnknownRestartCount(agentId: string): number {
  const entry = unknownRestartCounts.get(agentId);
  if (!entry) return 0;
  // Reset counter if enough time has passed
  if (Date.now() - entry.lastResetMs > UNKNOWN_RESTART_WINDOW_MS) {
    unknownRestartCounts.delete(agentId);
    return 0;
  }
  return entry.count;
}

function incrementUnknownRestartCount(agentId: string): number {
  const current = getUnknownRestartCount(agentId);
  const newCount = current + 1;
  unknownRestartCounts.set(agentId, { count: newCount, lastResetMs: Date.now() });
  return newCount;
}

function parseDbTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T')
    ? (raw.endsWith('Z') ? raw : raw + 'Z')
    : raw.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function analyzeWorkerExcerpt(excerpt: string): { signal: WorkerCompletionSignal; summary: string } {
  if (!excerpt) {
    return { signal: 'unknown', summary: 'no recent output captured' };
  }

  if (WAITING_USER_PATTERNS.some((re) => re.test(excerpt))) {
    return { signal: 'needs_user', summary: 'latest output indicates user decision/confirmation is needed' };
  }
  if (DONE_PATTERNS.some((re) => re.test(excerpt))) {
    return { signal: 'done', summary: 'latest output indicates task completion' };
  }
  if (CONTINUE_PATTERNS.some((re) => re.test(excerpt))) {
    return { signal: 'continue', summary: 'latest output indicates worker can continue execution' };
  }

  return { signal: 'unknown', summary: 'latest output does not clearly indicate next state' };
}

function loadLatestRunExcerpt(db: ReturnType<typeof getDatabase>, agentId: string): string {
  const latestRun = db.prepare(
    "SELECT run_id FROM conversation_logs WHERE agent_id = ? AND stream IN ('stdout', 'stderr') ORDER BY id DESC LIMIT 1"
  ).get(agentId) as { run_id?: string } | undefined;
  if (!latestRun?.run_id) return '';

  const rows = db.prepare(
    "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream IN ('stdout', 'stderr') ORDER BY id DESC LIMIT 30"
  ).all(agentId, latestRun.run_id) as { content: string }[];
  if (rows.length === 0) return '';

  const merged = rows
    .reverse()
    .map((r) => (r.content || '').trim())
    .filter(Boolean)
    .join('\n');

  if (!merged) return '';
  const compact = merged.replace(/\s+/g, ' ').trim();
  return compact.length > 1800 ? compact.slice(compact.length - 1800) : compact;
}

function collectWorkerOutcomeHints(state: { agents: Agent[]; issues: Issue[] }): WorkerOutcomeHint[] {
  const db = getDatabase();
  const now = Date.now();
  const activeByAgent = new Map<string, Issue[]>();

  for (const issue of state.issues) {
    if (!issue.assigned_to || issue.assigned_to === 'user' || issue.assigned_to === 'all') continue;
    const current = activeByAgent.get(issue.assigned_to) || [];
    current.push(issue);
    activeByAgent.set(issue.assigned_to, current);
  }

  const hints: WorkerOutcomeHint[] = [];
  for (const worker of state.agents) {
    if (worker.is_controller) continue;
    if (worker.status !== 'idle') continue;

    const assignedIssues = activeByAgent.get(worker.id) || [];
    if (assignedIssues.length === 0) continue;

    const finishedAt = parseDbTimestamp(worker.finished_at);
    if (!finishedAt) continue;

    const ageMs = now - finishedAt;
    if (ageMs < 0 || ageMs > 60 * 60 * 1000) continue;

    const excerpt = loadLatestRunExcerpt(db, worker.id);
    if (!excerpt) continue;

    const analysis = analyzeWorkerExcerpt(excerpt);
    hints.push({
      agentId: worker.id,
      signal: analysis.signal,
      summary: analysis.summary,
      excerpt: excerpt.length > 260 ? excerpt.slice(excerpt.length - 260) : excerpt,
      issueCount: assignedIssues.length,
      issueIds: assignedIssues.map((i) => i.id),
      issueNumbers: assignedIssues.map((i) => i.number),
    });
  }

  return hints;
}

function reconcileNeedsUserOutcomes(project: Project, hints: WorkerOutcomeHint[], agents: Agent[]): ReconcileNeedsUserResult {
  const db = getDatabase();
  const idleReasons: string[] = [];
  let movedCount = 0;
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const eventStmt = db.prepare(
    'INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const hint of hints) {
    if (hint.signal !== 'needs_user') continue;

    const agentName = agentNameById.get(hint.agentId) || hint.agentId;

    for (let i = 0; i < hint.issueIds.length; i++) {
      const issueId = hint.issueIds[i];
      const issueNumber = hint.issueNumbers[i] || 0;
      const issueRow = db.prepare(
        "SELECT assigned_to FROM issues WHERE id = ? AND project_id = ? AND status IN ('open', 'in_progress')"
      ).get(issueId, project.id) as { assigned_to: string | null } | undefined;
      if (!issueRow || issueRow.assigned_to === 'user') continue;

      db.prepare(
        "UPDATE issues SET assigned_to = 'user', updated_at = datetime('now') WHERE id = ?"
      ).run(issueId);

      const metaBase = {
        source: 'langgraph_worker_outcome',
        signal: hint.signal,
        agent_id: hint.agentId,
        issue_number: issueNumber,
      };

      eventStmt.run(
        uuidv4(),
        issueId,
        'system',
        'assigned to user (auto-handoff from ' + agentName + ')',
        'assignment',
        JSON.stringify({ ...metaBase, from: hint.agentId, to: 'user' })
      );

      const commentBody =
        'Auto-handoff by orchestrator: worker ' + agentName + ' ended with signal "' + hint.signal + '".\n' +
        'Summary: ' + hint.summary + '\n' +
        (hint.excerpt ? 'Worker excerpt: ' + hint.excerpt : '');

      eventStmt.run(
        uuidv4(),
        issueId,
        'system',
        commentBody,
        'comment',
        JSON.stringify({ ...metaBase, excerpt: hint.excerpt })
      );

      movedCount += 1;
      idleReasons.push('auto-assigned issue #' + (issueNumber || '?') + ' to user after ' + agentName + ' signaled needs_user');
    }
  }

  return { movedCount, idleReasons };
}

function createControllerBackoffPlan(state: {
  idleReasons: string[];
  controllerReasons: string[];
  issues: Issue[];
  dispatchResults: OrchestrationDispatchResult[];
}): ControllerBackoffPlan {
  if (state.controllerReasons.length > 0) return null;

  const dispatchCount = state.dispatchResults.filter((result) => result.started).length;
  if (dispatchCount > 0) return null;

  const idleReasons = state.idleReasons.filter(Boolean);
  if (idleReasons.length === 0 && state.issues.length === 0) {
    return {
      ms: IDLE_CONTROLLER_BACKOFF_MS,
      reason: 'No active issues remain for controller orchestration',
      label: 'idle',
    };
  }

  const waitingUserReason = idleReasons.find((reason) => reason.includes('waiting on user'));
  if (waitingUserReason) {
    return {
      ms: WAITING_USER_BACKOFF_MS,
      reason: idleReasons.join('; '),
      label: 'waiting_user',
    };
  }

  if (idleReasons.length === 0) return null;

  return {
    ms: IDLE_CONTROLLER_BACKOFF_MS,
    reason: idleReasons.join('; '),
    label: 'idle',
  };
}

const controllerGraph = new StateGraph(ControllerGraphState)
  .addNode('collect_context', (state) => {
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(state.project.id) as Project | undefined;
    const agents = db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at').all(state.project.id) as Agent[];
    // Exclude pending/done/closed issues — they don't need dispatch.
    // When triggered by a specific issue, still filter by status to avoid dispatching
    // workers for pending issues (which are waiting on child issues).
    const issues = state.triggerIssueNumber
      ? db.prepare(
          "SELECT * FROM issues WHERE project_id = ? AND number = ? AND status IN ('open', 'in_progress')"
        ).all(state.project.id, state.triggerIssueNumber) as Issue[]
      : db.prepare(
          "SELECT * FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
        ).all(state.project.id) as Issue[];

    if (!project) {
      return {
        agents,
        issues,
        controllerDecision: 'finish' as ControllerDecision,
        controllerReasons: ['Project not found during orchestration run'],
      };
    }

    return { project, agents, issues };
  })
  .addNode('inspect_worker_outcomes', (state) => {
    const hints = collectWorkerOutcomeHints(state);
    const reconciled = reconcileNeedsUserOutcomes(state.project, hints, state.agents);
    const db = getDatabase();
    // Re-fetch active issues (exclude pending — handled by system-level parent-child logic)
    const refreshedIssues = db.prepare(
      "SELECT * FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
    ).all(state.project.id) as Issue[];

    if (hints.length > 0 || reconciled.movedCount > 0) {
      logger.info(
        'LangGraph worker outcome hints detected (project=' + state.project.id + ', hints=' + hints.length + ', moved_to_user=' + reconciled.movedCount + ')'
      );
    }

    return {
      workerOutcomeHints: hints,
      issues: refreshedIssues,
      idleReasons: reconciled.idleReasons,
    };
  })
  .addNode('plan', (state) => {
    const workers = state.agents.filter((a) => !a.is_controller);
    const activeByAgent = new Map<string, Issue[]>();
    const hintsByAgent = new Map(state.workerOutcomeHints.map((h) => [h.agentId, h]));
    const controllerReasons: string[] = [...state.controllerReasons];
    const idleReasons: string[] = [...state.idleReasons];

    for (const issue of state.issues) {
      if (!issue.assigned_to || issue.assigned_to === 'user' || issue.assigned_to === 'all') continue;
      const current = activeByAgent.get(issue.assigned_to) || [];
      current.push(issue);
      activeByAgent.set(issue.assigned_to, current);
    }

    const actions: OrchestrationWorkerAction[] = [];
    for (const worker of workers) {
      const assignedIssues = activeByAgent.get(worker.id) || [];
      if (worker.paused) {
        if (assignedIssues.length > 0) {
          controllerReasons.push('worker ' + worker.name + ' is paused but still has ' + assignedIssues.length + ' active assigned issue(s)');
        }
        continue;
      }
      if (worker.status === 'running') continue;
      if (assignedIssues.length === 0) continue;

      const hint = hintsByAgent.get(worker.id);
      if (hint?.signal === 'needs_user') {
        controllerReasons.push('worker ' + worker.name + ' needs user decision but issue assignment was not updated');
        continue;
      }
      if (hint?.signal === 'done') {
        controllerReasons.push('worker ' + worker.name + ' appears done but still has ' + assignedIssues.length + ' active assigned issue(s)');
        continue;
      }
      if (hint?.signal === 'unknown') {
        const restartCount = getUnknownRestartCount(worker.id);
        if (restartCount < MAX_UNKNOWN_RESTARTS) {
          // Under retry limit: re-dispatch worker directly without LLM controller.
          // The worker will restart and continue working on its issues.
          incrementUnknownRestartCount(worker.id);
          idleReasons.push('worker ' + worker.name + ' finished without clear issue-state update (auto-restart ' + (restartCount + 1) + '/' + MAX_UNKNOWN_RESTARTS + ')');
          // Fall through to add to actions (don't continue)
        } else {
          // Exceeded retry limit: stop retrying, let it idle.
          // Don't push to controllerReasons — LLM controller can't fix this either.
          idleReasons.push('worker ' + worker.name + ' finished without clear issue-state update (' + MAX_UNKNOWN_RESTARTS + ' restarts exhausted, giving up)');
          continue;
        }
      }

      const actionReason = hint?.signal === 'continue'
        ? 'worker has ' + assignedIssues.length + ' active assigned issues; latest output suggests continue'
        : 'worker has ' + assignedIssues.length + ' active assigned issues';
      actions.push({
        agentId: worker.id,
        issueIds: assignedIssues.map((i) => i.id),
        issueNumbers: assignedIssues.map((i) => i.number),
        reason: actionReason,
      });
    }

    const controllerAgentIds = new Set(state.agents.filter((a) => a.is_controller).map((a) => a.id));
    const unassignedOrBroadcast = state.issues.filter((i) => !i.assigned_to || i.assigned_to === 'all').length;
    const assignedToController = state.issues.filter((i) => i.assigned_to && controllerAgentIds.has(i.assigned_to)).length;
    const userAssigned = state.issues.filter((i) => i.assigned_to === 'user').length;
    const erroredWorkers = workers.filter((w) => w.status === 'error').length;
    const missingAssignee = state.issues.filter(
      (i) => i.assigned_to && i.assigned_to !== 'user' && i.assigned_to !== 'all' && !state.agents.find((a) => a.id === i.assigned_to)
    ).length;

    if (unassignedOrBroadcast > 0) {
      controllerReasons.push(unassignedOrBroadcast + ' issue(s) are unassigned or broadcast');
    }
    if (assignedToController > 0) {
      controllerReasons.push(assignedToController + ' issue(s) are assigned to controller and need handling');
    }
    if (userAssigned > 0) {
      idleReasons.push(userAssigned + ' issue(s) are waiting on user');
    }
    if (erroredWorkers > 0) {
      controllerReasons.push(erroredWorkers + ' worker(s) are in error state');
    }
    if (missingAssignee > 0) {
      controllerReasons.push(missingAssignee + ' issue(s) reference missing assignees');
    }

    const shouldExecuteController = controllerReasons.length > 0;
    return {
      actions,
      controllerReasons,
      idleReasons,
      controllerDecision: shouldExecuteController ? ('execute_controller' as ControllerDecision) : ('finish' as ControllerDecision),
    };
  })
  .addNode('policy_gate', (state) => {
    if (state.project.status !== 'active') {
      return {
        actions: [],
        controllerDecision: 'finish' as ControllerDecision,
        controllerReasons: ['project status is ' + state.project.status],
      };
    }

    const issuesById = new Map(state.issues.map((issue) => [issue.id, issue]));
    const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
    const seen = new Set<string>();
    const allowedActions: OrchestrationWorkerAction[] = [];
    const reasons = [...state.controllerReasons];
    const idleReasons = [...state.idleReasons];

    for (const action of state.actions) {
      if (seen.has(action.agentId)) continue;
      seen.add(action.agentId);

      const agent = agentsById.get(action.agentId);
      if (!agent) {
        reasons.push('agent ' + action.agentId + ' disappeared before dispatch');
        continue;
      }
      if (agent.is_controller) continue;
      if (agent.paused) continue;
      if (agent.status === 'running') continue;

      const validIssues = action.issueIds
        .map((id) => issuesById.get(id))
        .filter((issue): issue is Issue => !!issue);
      if (validIssues.length === 0) continue;

      allowedActions.push({
        agentId: action.agentId,
        issueIds: validIssues.map((i) => i.id),
        issueNumbers: validIssues.map((i) => i.number),
        reason: action.reason,
      });
    }

    if (allowedActions.length === 0 && state.issues.length > 0 && reasons.length === 0) {
      idleReasons.push('No dispatchable worker actions were allowed by policy');
    }

    const shouldExecuteController = reasons.length > 0;
    return {
      actions: allowedActions,
      controllerReasons: reasons,
      idleReasons,
      controllerDecision: shouldExecuteController ? ('execute_controller' as ControllerDecision) : ('finish' as ControllerDecision),
    };
  })
  .addNode('dispatch_actions', (state) => {
    const db = getDatabase();
    const results: OrchestrationDispatchResult[] = [];
    let forceController = false;

    for (const action of state.actions) {
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(action.agentId) as Agent | undefined;
      if (!agent) {
        forceController = true;
        results.push({ agentId: action.agentId, started: false, message: 'agent not found at dispatch time' });
        continue;
      }
      if (agent.is_controller || agent.paused || agent.status === 'running') {
        forceController = true;
        results.push({ agentId: action.agentId, started: false, message: 'agent unavailable (status=' + agent.status + ', paused=' + agent.paused + ')' });
        continue;
      }

      const assignedIssues = db.prepare(
        "SELECT * FROM issues WHERE project_id = ? AND assigned_to = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
      ).all(state.project.id, agent.id) as Issue[];
      if (assignedIssues.length === 0) {
        results.push({ agentId: action.agentId, started: false, message: 'no active assigned issues at dispatch time' });
        continue;
      }

      const prompt = buildWorkerPrompt(state.project, agent, assignedIssues);
      const routeResult = resolveDispatchCommand(agent, assignedIssues, state.project);
      const commandTemplate = routeResult.commandTemplate;
      const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
      const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agent, state.project);

      try {
        const process = startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
        const issueBatch = getAgentIssueBatch(assignedIssues);
        markCurrentBatchInProgress(db, issueBatch);

        const routeTag = routeResult.routed
          ? ', model=' + routeResult.profileName + '(intel=' + routeResult.selectedIntelligence + ', required=' + routeResult.requiredIntelligence + ')'
          : '';
        logger.info(
          'LangGraph dispatched worker agent (project=' + state.project.id + ', agent=' + agent.id + ', issues=' + issueBatch.currentBatch.length + '/' + issueBatch.activeIssues.length + ', runId=' + process.runId + routeTag + ')'
        );
        results.push({
          agentId: action.agentId,
          started: true,
          message: 'started for ' + issueBatch.currentBatch.length + '/' + issueBatch.activeIssues.length + ' assigned issue(s) in current batch',
          runId: process.runId,
          pid: process.pid,
        });
      } catch (err: any) {
        forceController = true;
        results.push({
          agentId: action.agentId,
          started: false,
          message: 'failed to start: ' + (err?.message || String(err)),
        });
      }
    }

    const started = results.filter((r) => r.started).length;
    const skippedOrFailed = results.length - started;
    const summary = 'worker dispatch summary: ' + started + ' started, ' + skippedOrFailed + ' skipped/failed';

    const reasons = [...state.controllerReasons];
    if (forceController) reasons.push('worker dispatch had failures and needs controller recovery');

    return {
      dispatchResults: results,
      dispatchSummary: summary,
      controllerReasons: reasons,
      idleReasons: state.idleReasons,
      controllerDecision:
        forceController && state.controllerDecision === 'finish'
          ? ('execute_controller' as ControllerDecision)
          : state.controllerDecision,
    };
  })
  .addNode('execute_controller', (state) => {
    const commandTemplate =
      state.controller.command_template || state.project.command_template || config.defaultCommandTemplate;
    const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
    const systemPrompt = isRawShell ? undefined : buildSystemPrompt(state.controller, state.project);
    const agentNameById = new Map(state.agents.map((a) => [a.id, a.name]));
    const findings: string[] = [];

    for (const hint of state.workerOutcomeHints.slice(0, 8)) {
      const name = agentNameById.get(hint.agentId) || hint.agentId;
      findings.push('- ' + name + ' (' + hint.signal + '): ' + hint.summary + '. excerpt="' + hint.excerpt + '"');
    }
    if (state.controllerReasons.length > 0) {
      findings.push(
        ...state.controllerReasons.slice(0, 10).map((r) => '- decision reason: ' + r)
      );
    }

    const controllerPrompt = findings.length > 0
      ? state.taskPrompt + '\n\n## Orchestration Findings\n' + findings.join('\n') + '\n\nPlease decide whether to re-dispatch workers, assign issue to user, close issue, or create follow-up issues.'
      : state.taskPrompt;

    const result = startAgentProcess(
      state.controller,
      controllerPrompt,
      commandTemplate,
      systemPrompt
    );

    return {
      commandTemplate,
      systemPrompt,
      runId: result.runId,
      pid: result.pid,
    };
  })
  .addNode('finish', (state) => {
    const backoffPlan = createControllerBackoffPlan(state);
    const reasonText = state.controllerReasons.length > 0 ? state.controllerReasons.join('; ') : 'no controller work needed';
    const summary = state.dispatchSummary || 'no worker dispatch';
    const idleText = state.idleReasons.length > 0 ? '; idle=' + state.idleReasons.join('; ') : '';
    const backoffText = backoffPlan
      ? '; backoff=' + backoffPlan.label + ' (' + Math.round(backoffPlan.ms / 60000) + 'm)'
      : '';
    logger.info(
      'LangGraph orchestration finished without controller run (project=' + state.project.id + '): ' + summary + '; reasons=' + reasonText + idleText + backoffText
    );
    return {
      backoffMs: backoffPlan?.ms || 0,
      backoffReason: backoffPlan?.reason || '',
      backoffLabel: backoffPlan?.label || '',
    };
  })
  .addEdge(START, 'collect_context')
  .addEdge('collect_context', 'inspect_worker_outcomes')
  .addEdge('inspect_worker_outcomes', 'plan')
  .addEdge('plan', 'policy_gate')
  .addEdge('policy_gate', 'dispatch_actions')
  .addConditionalEdges('dispatch_actions', (state) => state.controllerDecision, {
    execute_controller: 'execute_controller',
    finish: 'finish',
  })
  .addEdge('execute_controller', END)
  .addEdge('finish', END)
  .compile();

export async function runControllerWithLangGraph(
  input: LangGraphControllerInput
): Promise<{
  controllerStarted: boolean;
  runId?: string;
  pid?: number;
  decision: ControllerDecision;
  dispatchSummary: string;
  dispatchCount: number;
  controllerReasons: string[];
  idleReasons: string[];
  actions: OrchestrationWorkerAction[];
  dispatchResults: OrchestrationDispatchResult[];
  backoffMs: number;
  backoffReason: string;
  backoffLabel?: ControllerBackoffLabel;
}> {
  const result = await controllerGraph.invoke({
    project: input.project,
    controller: input.controller,
    taskPrompt: input.taskPrompt,
    triggerIssueNumber: input.triggerIssueNumber,
  });

  const decision = (result.controllerDecision || 'finish') as ControllerDecision;
  const controllerStarted = !!result.runId && result.pid !== undefined;
  const dispatchResults = result.dispatchResults || [];

  if (decision === 'execute_controller' && !controllerStarted) {
    throw new Error('LangGraph decided to execute controller but did not return run metadata');
  }

  return {
    controllerStarted,
    runId: result.runId,
    pid: result.pid,
    decision,
    dispatchSummary: result.dispatchSummary || '',
    dispatchCount: dispatchResults.filter((r) => r.started).length,
    controllerReasons: result.controllerReasons || [],
    idleReasons: result.idleReasons || [],
    actions: result.actions || [],
    dispatchResults,
    backoffMs: result.backoffMs || 0,
    backoffReason: result.backoffReason || '',
    backoffLabel: (result.backoffLabel || undefined) as ControllerBackoffLabel | undefined,
  };
}
