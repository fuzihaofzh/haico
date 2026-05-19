import { expect, test } from '@playwright/test';
import { randomUUID } from 'crypto';
import { listE2EAgents } from './helpers/agents';
import { createE2EIssue } from './helpers/issues';
import { expectNoPageErrors, trackPageErrors } from './helpers/page-health';
import { createE2EProject, deleteE2EProject } from './helpers/projects';

test.describe('page smoke checks', () => {
  test('dashboard renders primary navigation and panels', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/');
    await expect(page).toHaveURL(/\/inbox$/);

    await expect(page).toHaveTitle(/Inbox - HAICO/);
    await expect(page.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Usage' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: '+ New Project' })).toHaveAttribute('href', '/projects/new');
    await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'inbox');

    await page.goto('/projects');
    await expect(page.locator('#projects-view-panel')).toBeVisible();
    await expect(page.getByRole('link', { name: '+ New Project' })).toHaveAttribute('href', '/projects/new');
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'projects');

    await page.goto('/usage');
    await expect(page.locator('#usage-by-project-panel')).toBeVisible();
    await expect(page.getByRole('link', { name: '+ New Project' })).toHaveAttribute('href', '/projects/new');
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'usage');

    await page.goto('/settings');
    await expect(page.locator('#settings-view-panel')).toBeVisible();
    await expect(page.locator('[data-command-profiles-root]').first()).toBeVisible();
    await expect(page.getByRole('link', { name: '+ New Project' })).toHaveAttribute('href', '/projects/new');
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'settings');

    await page.goto('/projects/new');
    await expect(page).toHaveTitle(/New Project - HAICO/);
    await expect(page.locator('#proj-task')).toBeVisible();
    await expect(page.locator('#proj-cmd-profile')).toBeVisible();
    await expect(page.locator('#proj-target-instance')).toBeVisible();
    await expect(page.locator('#proj-workdir')).toBeVisible();
    await expect(page.locator('#create-project-readiness')).toBeVisible();
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'projects');

    await expectNoPageErrors(pageErrors);
  });

  test('new project page creates a local project and redirects to detail', async ({ page, request }) => {
    const pageErrors = trackPageErrors(page);
    const unique = randomUUID().slice(0, 8);
    const profileResponse = await request.post('/api/command-profiles', {
      data: {
        name: `aa-e2e-tool-${unique}`,
        command: 'echo',
        type: 'codex',
      },
    });
    await expect(profileResponse, await profileResponse.text()).toBeOK();
    const profile = await profileResponse.json();
    let projectId = '';

    try {
      await page.goto('/projects/new');
      await page.locator('#proj-cmd-profile').selectOption(profile.id);
      await page.locator('#proj-task').fill(`Create a smoke test project ${unique}`);
      await page.getByRole('button', { name: 'Create' }).click();
      await page.waitForURL((url) => {
        const parts = url.pathname.split('/').filter(Boolean);
        return parts.length === 2 && parts[0] === 'projects' && parts[1] !== 'new';
      });
      projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() || '');
      await expect(page.locator('#project-title')).toBeVisible();
      await expectNoPageErrors(pageErrors);
    } finally {
      if (projectId && !projectId.includes(':')) {
        await deleteE2EProject(request, projectId);
      }
      await request.delete(`/api/command-profiles/${encodeURIComponent(profile.id)}`);
    }
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
