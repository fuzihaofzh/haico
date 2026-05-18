import { expect, test } from '@playwright/test';
import { createE2EProject, deleteE2EProject } from './helpers/projects';

test('dashboard shows a project created through the API', async ({ page, request }) => {
  const project = await createE2EProject(request);

  try {
    await page.goto('/');

    await expect(page).toHaveTitle(/HAICO/);
    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.locator('.project-card-title').getByText(project.name, { exact: true })).toBeVisible();
  } finally {
    await deleteE2EProject(request, project.id);
  }
});
