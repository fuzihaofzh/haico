import { expect, test } from '@playwright/test';
import { listE2EAgents } from './helpers/agents';
import { createE2EIssue } from './helpers/issues';
import { expectNoPageErrors, trackPageErrors } from './helpers/page-health';
import { createE2EProject, deleteE2EProject } from './helpers/projects';

test.describe('page smoke checks', () => {
  test('dashboard renders primary navigation and panels', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/');

    await expect(page).toHaveTitle(/HAICO/);
    await expect(page.getByRole('button', { name: 'Inbox' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Usage' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();

    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.locator('#projects-view-panel')).toBeVisible();

    await page.getByRole('button', { name: 'Usage' }).click();
    await expect(page.locator('#usage-by-project-panel')).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('#settings-view-panel')).toBeVisible();
    await expect(page.locator('[data-command-profiles-root]').first()).toBeVisible();

    await expectNoPageErrors(pageErrors);
  });

  test('project page renders overview, agents, issues, and knowledge tabs', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const issue = await createE2EIssue(request, project.id);
    const pageErrors = trackPageErrors(page);

    try {
      await page.goto(`/projects/${project.id}`);

      await expect(page).toHaveTitle(new RegExp(project.name));
      await expect(page.locator('#project-title')).toContainText(project.name);
      await expect(page.locator('#project-status')).toBeVisible();
      await expect(page.getByText('Overview')).toBeVisible();
      await expect(page.locator('#project-name-edit')).toHaveValue(project.name);
      await expect(page.locator('#project-task')).toBeVisible();

      await page.locator('.tab-bar .tab').filter({ hasText: /^Agents/ }).click();
      await expect(page.locator('#agent-list')).toBeVisible();
      await expect(page.locator('.agent-item')).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'New Agent' })).toBeVisible();

      await page.locator('.tab-bar .tab').filter({ hasText: /^Issues/ }).click();
      await expect(page.locator('#issue-list')).toBeVisible();
      await expect(page.locator('.issue-title').filter({ hasText: issue.title })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New Issue' })).toBeVisible();

      await page.locator('.tab-bar .tab').filter({ hasText: 'Knowledge' }).click();
      await expect(page.locator('#knowledge-list')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add Knowledge' })).toBeVisible();

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });

  test('issue page renders detail, sidebar fields, and comment controls', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const issue = await createE2EIssue(request, project.id);
    const pageErrors = trackPageErrors(page);

    try {
      await page.goto(`/issues/${issue.id}`);

      await expect(page).toHaveTitle(new RegExp(issue.title));
      await expect(page.locator('#issue-page')).toContainText(issue.title);
      await expect(page.locator('#ir-title-display')).toBeVisible();
      await expect(page.locator('#ir-body-display')).toContainText('verify the issue page layout');
      await expect(page.locator('#ir-detail-status')).toBeVisible();
      await expect(page.locator('#ir-detail-assign')).toBeVisible();
      await expect(page.locator('#ir-comment-input')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Comment' })).toBeVisible();

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });

  test('agent page renders settings, messages, and terminal workspace', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const agents = await listE2EAgents(request, project.id);
    const agent = agents.find((candidate) => candidate.is_controller) || agents[0];
    const pageErrors = trackPageErrors(page);

    try {
      await page.goto(`/agents/${agent.id}`);

      await expect(page).toHaveTitle(new RegExp(agent.name));
      await expect(page.locator('#agent-title')).toContainText(agent.name);
      await expect(page.locator('#agent-status')).toBeVisible();
      await expect(page.locator('#agent-role')).not.toBeEmpty();
      await expect(page.locator('#agent-command-profile')).toBeVisible();
      await expect(page.locator('#agent-instructions')).toBeVisible();
      await expect(page.locator('#messages-panel')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();
      await expect(page.locator('#workspace-terminal-panel')).toBeVisible();
      await expect(page.locator('#terminal')).toBeVisible();

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });
});
