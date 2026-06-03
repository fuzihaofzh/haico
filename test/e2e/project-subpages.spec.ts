import { expect, test } from './fixtures';
import { trackPageErrors, expectNoPageErrors } from './helpers/page-health';
import { createE2EProject, deleteE2EProject } from './helpers/projects';
import { listE2EAgents } from './helpers/agents';

test.describe('project subpage rendering', () => {
  test('project sharing page renders member management', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const pageErrors = trackPageErrors(page);

    try {
      await page.goto(`/project/${project.id}/sharing`);

      await expect(page.locator('#tab-sharing')).toBeVisible();
      await expect(page.locator('#project-share-username')).toBeVisible();
      await expect(page.locator('#project-share-role')).toBeVisible();
      await expect(page.locator('#btn-add-member')).toBeVisible();
      await expect(page.locator('#btn-add-member')).toHaveText('Grant Access');
      await expect(page.locator('#project-members-list')).toBeVisible();

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });

  test('operations console page renders lane watch and detail panels', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const pageErrors = trackPageErrors(page);

    try {
      await page.goto(`/project/${project.id}/operations-console`);

      await expect(page.locator('#ops-project-title')).toBeVisible();
      await expect(page.locator('#lane-list')).toBeVisible();
      await expect(page.locator('#detail-panel')).toBeVisible();
      await expect(page.locator('#dispatch-timeline')).toBeVisible();
      await expect(page.locator('#customer-feed')).toBeVisible();

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });

  test('terminal page renders toolbar and terminal element', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const agents = await listE2EAgents(request, project.id);
    const agent = agents.find((candidate) => !candidate.is_controller) || agents[0];
    const pageErrors = trackPageErrors(page);

    try {
      await page.goto(`/terminal?agentId=${agent.id}&projectId=${project.id}`);

      await expect(page.locator('#agent-name')).toBeVisible();
      await expect(page.locator('#terminal')).toBeVisible();
      await expect(page.locator('#connection-status')).toBeVisible();

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });
});
