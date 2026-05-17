import { execSync } from 'child_process';
import { config } from '../../config';
import { resolveCommandType } from '../command-profiles';
import { classifyToolExecutionFailure, inspectToolReadiness } from '../tool-readiness';
import {
  MissingProjectMetadataDescriptionError,
  ProjectMetadataInvalidResponseError,
  ProjectMetadataToolError,
} from './errors';

export interface GenerateProjectMetadataInput {
  description?: string;
  tool_path?: string;
  command_type?: string | null;
}

function buildProjectMetadataPrompt(description: string): string {
  return `Given the user's input below, generate a JSON object. IMPORTANT: Use the SAME LANGUAGE as the user's input (if Chinese, respond in Chinese; if English, respond in English).

Fields:
- "name": short project name in English (lowercase, hyphens, max 30 chars)
- "description": one-line summary (max 100 chars, same language as user)
- "task_description": detailed instructions for the controller agent (2-5 sentences, same language as user)
- "controller_role": role description for the controller agent (same language as user)
- "working_directory": if the user mentions a path or directory, extract it here (absolute path); otherwise null

User's input: "${description.replace(/"/g, '\\"')}"

Respond with ONLY valid JSON, no markdown, no explanation.`;
}

function buildMetadataCommand(tool: string, commandType: string | null): string {
  const lowerTool = tool.toLowerCase();
  const toolBinary = tool.split(/\s+/).filter(Boolean)[0] || tool;

  if (commandType === 'claude') {
    return `${tool} -p`;
  }

  if (lowerTool.startsWith('gemini')) {
    return `${tool} --output-format text -p`;
  }

  if (commandType === 'codex') {
    return `${toolBinary} exec --sandbox workspace-write --skip-git-repo-check -`;
  }

  return tool;
}

export function generateProjectMetadata(input: GenerateProjectMetadataInput): any {
  const description = String(input.description || '');
  if (!description) throw new MissingProjectMetadataDescriptionError();

  const tool = (input.tool_path || config.defaultCommandTemplate || '').trim() || 'cld';
  const prompt = buildProjectMetadataPrompt(description);
  const resolvedCommandType = resolveCommandType(input.command_type, tool);
  const readiness = inspectToolReadiness({
    commandTemplate: tool,
    commandType: resolvedCommandType,
  });

  if (!readiness.binary_found) {
    throw new ProjectMetadataToolError(
      readiness.issues.find((issue) => issue.code === 'missing_cli')?.detail || `Tool "${readiness.binary}" is not installed`,
      'missing_cli',
      readiness
    );
  }

  try {
    const cmd = buildMetadataCommand(tool, resolvedCommandType);
    const result = execSync(`echo ${JSON.stringify(prompt)} | ${cmd}`, {
      timeout: 60000,
      encoding: 'utf-8',
      env: { ...process.env },
    }).trim();

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new ProjectMetadataInvalidResponseError(result);
    }

    return { ...JSON.parse(jsonMatch[0]) };
  } catch (error) {
    if (error instanceof ProjectMetadataInvalidResponseError) throw error;

    const failure = classifyToolExecutionFailure({
      error,
      commandType: resolvedCommandType,
      binary: readiness.binary,
    });
    throw new ProjectMetadataToolError(
      failure.message,
      failure.code,
      readiness,
      failure.action_command
    );
  }
}
