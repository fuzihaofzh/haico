import { execSync } from 'child_process';
import { config } from '../../config';
import { getAdapterRegistry } from '../adapters';
import { classifyToolExecutionFailure } from '../tool-readiness';
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

export function generateProjectMetadata(input: GenerateProjectMetadataInput): any {
  const description = String(input.description || '');
  if (!description) throw new MissingProjectMetadataDescriptionError();

  const tool = (input.tool_path || config.defaultCommandTemplate || '').trim() || 'cld';
  const prompt = buildProjectMetadataPrompt(description);
  const adapter = getAdapterRegistry().resolveFromCommand(tool, input.command_type);
  const readiness = adapter.inspectReadiness(tool);

  if (!readiness.binary_found) {
    throw new ProjectMetadataToolError(
      readiness.issues.find((issue) => issue.code === 'missing_cli')?.detail || `Tool "${readiness.binary}" is not installed`,
      'missing_cli',
      readiness
    );
  }

  try {
    const cmd = adapter.buildMetadataCommand(tool);
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
      commandType: adapter.type as any,
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
