import { expect, test } from './fixtures';
import { randomUUID } from 'crypto';
import { listE2EAgents } from './helpers/agents';
import { expectNoPageErrors, trackPageErrors } from './helpers/page-health';
import { createE2EProject, deleteE2EProject } from './helpers/projects';

test('agent run history renders TaskRun records created by manual start', async ({ page, request }) => {
  const project = await createE2EProject(request);
  const agents = await listE2EAgents(request, project.id);
  const agent = agents.find((candidate) => !candidate.is_controller) || agents[0];
  const prompt = `E2E TaskRun history ${randomUUID()}`;
  const pageErrors = trackPageErrors(page);

  try {
    const start = await request.post(`/api/agents/${encodeURIComponent(agent.id)}/start`, {
      data: { prompt },
    });
    await expect(start, await start.text()).toBeOK();
    const started = await start.json();
    expect(started.task_id).toBeTruthy();
    expect(started.task_run_id).toBeTruthy();

    await expect.poll(async () => {
      const response = await request.get(`/api/agents/${encodeURIComponent(agent.id)}/task-runs?limit=5`);
      if (!response.ok()) return `http-${response.status()}`;
      const body = await response.json();
      const run = (body.task_runs || []).find((candidate: any) =>
        candidate.task_run_id === started.task_run_id
      );
      return run?.task_run_status || 'missing';
    }, { timeout: 10_000 }).toBe('completed');

    await page.goto(`/projects/${project.id}/agents`);
    await expect(page.locator('#agent-list')).toBeVisible();
    await page.locator('.agent-item').filter({ hasText: agent.name }).first().click();

    const historyToggle = page.locator(`#agent-runs-arrow-${agent.id}`).locator('xpath=..');
    const history = page.locator(`#agent-runs-${agent.id}`);
    await expect(historyToggle).toBeVisible();
    await historyToggle.click();
    await expect(history).toBeVisible();
    await expect(history).toContainText('attempt 1');
    await expect(history).toContainText('manual');
    await expect(history).toContainText('completed');

    await expectNoPageErrors(pageErrors);
  } finally {
    await deleteE2EProject(request, project.id);
  }
});
