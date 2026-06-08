import { trimString } from '../command-profiles';
import type { ChatProjectSummary, DashboardChatMessage } from './types';
import { MAX_HISTORY_MESSAGES, MAX_TOOL_RESULT_CHARS } from './policy';

export function normalizeMessages(
  messages: DashboardChatMessage[] | undefined,
  latestMessage: string,
): DashboardChatMessage[] {
  const normalized = Array.isArray(messages)
    ? messages
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
      .map((message) => ({
        role: message.role,
        content: trimString(message.content),
      }))
      .filter((message) => message.content)
    : [];

  if (
    !normalized.length ||
    normalized[normalized.length - 1].role !== 'user' ||
    normalized[normalized.length - 1].content !== latestMessage
  ) {
    normalized.push({ role: 'user', content: latestMessage });
  }

  return normalized.slice(-MAX_HISTORY_MESSAGES);
}

export function inferLanguageLabel(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return 'Chinese';
  if (/[ぁ-んァ-ヶ]/.test(text)) return 'Japanese';
  if (/[가-힣]/.test(text)) return 'Korean';
  return 'same as the user';
}

export function truncateForPrompt(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...truncated...`;
}

export function buildProjectCatalogForPrompt(projects: ChatProjectSummary[]): string {
  return JSON.stringify(
    projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      is_remote: project.is_remote,
      machine: project.remote_instance_name || null,
      remote_base_url: project.remote_base_url || null,
      can_manage: project.can_manage,
      running_agents: project.stats.running,
      total_agents: project.stats.agents,
      open_issues: project.stats.openIssues,
      total_issues: project.stats.issues,
      updated_at: project.updated_at,
    })),
    null,
    2,
  );
}

export function buildChatPrompt(input: {
  projects: ChatProjectSummary[];
  selectedProject: ChatProjectSummary | null;
  messages: DashboardChatMessage[];
  toolResults: Array<{ tool: string; arguments: Record<string, unknown>; result: unknown }>;
  latestMessage: string;
}): string {
  const languageLabel = inferLanguageLabel(input.latestMessage);
  const toolSection = input.toolResults.length
    ? input.toolResults.map((item, index) => (
      `Tool result ${index + 1}\nTool: ${item.tool}\nArguments: ${JSON.stringify(item.arguments, null, 2)}\nResult:\n${truncateForPrompt(item.result)}`
    )).join('\n\n')
    : '(none yet)';

  return `You are HAICO's dashboard chat assistant.

Core rules:
- Reply in ${languageLabel}. If the user switches language, switch too.
- You are operating inside the HAICO dashboard, not inside a coding workspace.
- Use tools whenever the user asks about projects, issues, agents, status, progress, creation, updates, comments, deletion, or delegation.
- Never invent project IDs, issue IDs, agent IDs, status, or progress.
- Do not do long-running work yourself. If the user requests implementation, investigation, coding, research, monitoring, terminal work, file edits, or anything that should be carried out by HAICO agents, create a delegated issue instead of pretending to do it directly.
- Prefer assigning long-running tasks to the controller unless the user clearly names a specific agent and that agent exists.
- Destructive actions like delete_project and delete_issue require explicit confirmation from the user in the latest message. If the confirmation is not explicit, do not call the delete tool. Ask a short confirmation question instead.
- If the user asks for project progress, first identify the right project, then use get_project_progress and any extra issue lookups needed before answering.
- Keep answers concise and operational. Mention the exact project or issue you used.

Available tools:
- search_projects {"query": string?, "limit": number?}
- get_project {"project_id": string}
- get_project_progress {"project_id": string, "limit": number?}
- list_project_agents {"project_id": string}
- list_project_issues {"project_id": string, "status": string?, "assigned_to": string?, "q": string?, "limit": number?}
- get_issue {"issue_id": string}
- get_issue_by_number {"project_id": string, "issue_number": number|string}
- create_issue {"project_id": string, "title": string, "body": string, "assigned_to": string?, "labels": string?, "parent_id": string?}
- update_issue {"issue_id": string, "status": string?, "assigned_to": string?, "title": string?, "body": string?, "labels": string?}
- add_issue_comment {"issue_id": string, "body": string}
- delete_issue {"issue_id": string, "confirm": boolean}
- create_project_from_request {"request": string, "target_instance_id": string?}
- update_project {"project_id": string, "name": string?, "description": string?, "task_description": string?, "status": string?, "color": string?}
- delete_project {"project_id": string, "confirm": boolean}
- delegate_task {"project_id": string, "title": string, "details": string, "agent_id": string?, "agent_name": string?}

Current accessible projects:
${buildProjectCatalogForPrompt(input.projects)}

Selected project preference:
${input.selectedProject ? JSON.stringify(input.selectedProject, null, 2) : 'null'}

Conversation so far:
${JSON.stringify(input.messages, null, 2)}

Tool outputs from this turn:
${toolSection}

Return ONLY one JSON object in one of these shapes:
{"type":"answer","message":"..."}
{"type":"tool_call","tool":"search_projects","arguments":{"query":"google"}}
`;
}
