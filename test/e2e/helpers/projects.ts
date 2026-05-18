import { APIRequestContext, expect } from '@playwright/test';
import { randomUUID } from 'crypto';

export interface E2EProject {
  id: string;
  name: string;
}

export async function createE2EProject(
  request: APIRequestContext,
  overrides: Partial<Record<string, unknown>> = {}
): Promise<E2EProject> {
  const unique = randomUUID().slice(0, 8);
  const name = `e2e-project-${unique}`;
  const response = await request.post('/api/projects', {
    data: {
      name,
      description: 'Created by Playwright E2E setup',
      task_description: 'Verify dashboard rendering with a seeded project',
      command_template: 'echo',
      ...overrides,
    },
  });

  await expect(response, await response.text()).toBeOK();
  return response.json();
}

export async function deleteE2EProject(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.delete(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Failed to delete E2E project ${projectId}: ${response.status()} ${await response.text()}`);
  }
}
