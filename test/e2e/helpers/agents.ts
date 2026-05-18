import { APIRequestContext, expect } from '@playwright/test';

export interface E2EAgent {
  id: string;
  name: string;
  is_controller?: number | boolean;
}

export async function listE2EAgents(request: APIRequestContext, projectId: string): Promise<E2EAgent[]> {
  const response = await request.get(`/api/projects/${encodeURIComponent(projectId)}/agents`);

  await expect(response, await response.text()).toBeOK();
  return response.json();
}
