import Database from 'better-sqlite3';
import { config } from '../../config';
import { getDatabase } from '../../db/database';
import type { ProjectRequestContext } from '../project-access';
import { getAdapterRegistry } from '../adapters';
import { trimString } from '../command-profiles';
import { DashChatInputError, DashChatCommandError } from './errors';
import { runCliTurn, parseAssistantEnvelope } from './llm-client';
import { buildChatPrompt, normalizeMessages } from './prompt';
import { executeChatTool, loadAccessibleProjects } from './tools';
import type {
  ChatLogger,
  ChatToolContext,
  CommandSelection,
  DashboardChatInput,
  DashboardChatResult,
  DashboardChatToolCall,
} from './types';
import { MAX_CHAT_STEPS } from './policy';

function resolveCommandSelection(db: Database.Database, input: DashboardChatInput): CommandSelection {
  const requestedProfileId = trimString(input.command_profile_id);

  if (requestedProfileId) {
    const profile = db.prepare(
      'SELECT id, name, command, type FROM command_profiles WHERE id = ?',
    ).get(requestedProfileId) as
      | { id: string; name: string; command: string; type: string }
      | undefined;
    if (!profile) {
      throw new DashChatCommandError('Selected Agent Tool was not found');
    }
    return {
      template: trimString(profile.command),
      type: getAdapterRegistry().resolveFromCommand(profile.command, profile.type).type,
      profileId: profile.id,
      profileName: trimString(profile.name) || 'Agent Tool',
    };
  }

  const inlineCommand = trimString(input.command);
  if (inlineCommand) {
    return {
      template: inlineCommand,
      type: getAdapterRegistry().resolveFromCommand(inlineCommand, input.command_type).type,
      profileId: null,
      profileName: 'Custom command',
    };
  }

  const firstProfile = db.prepare(
    'SELECT id, name, command, type FROM command_profiles ORDER BY lower(name), created_at LIMIT 1',
  ).get() as
    | { id: string; name: string; command: string; type: string }
    | undefined;
  if (firstProfile) {
    return {
      template: trimString(firstProfile.command),
      type: getAdapterRegistry().resolveFromCommand(firstProfile.command, firstProfile.type).type,
      profileId: firstProfile.id,
      profileName: trimString(firstProfile.name) || 'Agent Tool',
    };
  }

  return {
    template: config.defaultCommandTemplate,
    type: getAdapterRegistry().resolveFromCommand(config.defaultCommandTemplate, input.command_type).type,
    profileId: null,
    profileName: 'Default CLI',
  };
}

export async function runDashboardChatTurn(
  userContext: ProjectRequestContext,
  logger: ChatLogger,
  input: DashboardChatInput,
): Promise<DashboardChatResult> {
  const latestMessage = trimString(input.message);
  if (!latestMessage) {
    throw new DashChatInputError('message is required');
  }

  const db = getDatabase();
  const command = resolveCommandSelection(db, input);
  const adapter = getAdapterRegistry().resolveFromCommand(command.template, command.type);
  const readiness = adapter.inspectReadiness(command.template);
  if (!readiness.binary_found) {
    throw new DashChatCommandError(
      readiness.issues.find((issue) => issue.code === 'missing_cli')?.detail
      || `Tool "${readiness.binary}" is not installed`,
    );
  }
  if (readiness.auth.status === 'missing') {
    throw new DashChatCommandError(readiness.auth.message);
  }

  const seedContext: ChatToolContext = {
    db,
    userContext,
    logger,
    command,
    availableProjects: [],
  };

  const remoteSummaries = await loadAccessibleProjects(seedContext);
  seedContext.availableProjects = remoteSummaries;

  const selectedProjectId = trimString(input.project_id);
  const selectedProject = selectedProjectId
    ? seedContext.availableProjects.find((project) => project.id === selectedProjectId) || null
    : null;
  const messages = normalizeMessages(input.messages, latestMessage);
  const toolCalls: DashboardChatToolCall[] = [];
  const toolResults: Array<{ tool: string; arguments: Record<string, unknown>; result: unknown }> = [];

  logger.debug({
    selectedProjectId: selectedProject?.id || null,
    projectCount: seedContext.availableProjects.length,
    commandType: command.type,
    profileId: command.profileId,
  }, 'dashboard_chat.started');

  for (let step = 0; step < MAX_CHAT_STEPS; step += 1) {
    const prompt = buildChatPrompt({
      projects: seedContext.availableProjects,
      selectedProject,
      messages,
      toolResults,
      latestMessage,
    });
    const rawOutput = runCliTurn(command.template, command.type, prompt);
    const envelope = parseAssistantEnvelope(rawOutput);

    if (envelope.type === 'answer') {
      logger.debug({
        selectedProjectId: selectedProject?.id || null,
        stepCount: step + 1,
        toolCallCount: toolCalls.length,
        commandType: command.type,
        profileId: command.profileId,
      }, 'dashboard_chat.completed');
      return {
        message: envelope.message,
        tool_calls: toolCalls,
        command: {
          template: command.template,
          type: command.type,
          profile_id: command.profileId,
          profile_name: command.profileName,
        },
      };
    }

    toolCalls.push({
      tool: envelope.tool,
      arguments: envelope.arguments,
    });

    try {
      const result = await executeChatTool(seedContext, envelope.tool, envelope.arguments);
      toolResults.push({
        tool: envelope.tool,
        arguments: envelope.arguments,
        result,
      });
    } catch (error: any) {
      logger.warn({
        err: error,
        tool: envelope.tool,
        selectedProjectId: selectedProject?.id || null,
      }, 'dashboard_chat.tool_failed');
      toolResults.push({
        tool: envelope.tool,
        arguments: envelope.arguments,
        result: { error: String(error?.message || error || 'Tool failed') },
      });
    }
  }

  logger.warn({
    selectedProjectId: selectedProject?.id || null,
    toolCallCount: toolCalls.length,
    maxSteps: MAX_CHAT_STEPS,
  }, 'dashboard_chat.step_limit_reached');
  return {
    message: 'I hit the tool-call limit for this turn. Please narrow the request or specify the exact project or issue you want me to operate on.',
    tool_calls: toolCalls,
    command: {
      template: command.template,
      type: command.type,
      profile_id: command.profileId,
      profile_name: command.profileName,
    },
  };
}
