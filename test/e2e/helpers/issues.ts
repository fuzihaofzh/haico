import { APIRequestContext, expect } from '@playwright/test';
import { randomUUID } from 'crypto';

export interface E2EIssue {
  id: string;
  number: number;
  title: string;
}

export async function createE2EIssue(
  request: APIRequestContext,
  projectId: string,
  overrides: Partial<Record<string, unknown>> = {}
): Promise<E2EIssue> {
  const unique = randomUUID().slice(0, 8);
  const title = `E2E issue ${unique}`;
  const response = await request.post(`/api/projects/${encodeURIComponent(projectId)}/issues`, {
    data: {
      title,
      body: 'This issue exists so Playwright can verify the issue page layout.',
      created_by: 'user',
      labels: 'e2e,smoke',
      ...overrides,
    },
  });

  await expect(response, await response.text()).toBeOK();
  return response.json();
}
