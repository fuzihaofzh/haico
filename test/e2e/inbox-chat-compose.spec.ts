import { expect, test } from './fixtures';
import { expectNoPageErrors, trackPageErrors } from './helpers/page-health';

test.describe('inbox, chat, and compose pages', () => {
  test('inbox page renders notification panel and controls', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/inbox');
    await expect(page).toHaveTitle(/Inbox - HAICO/);

    await expect(page.locator('#notifications-panel')).toBeVisible();
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'inbox');
    await expect(page.locator('#inbox-search')).toBeVisible();

    await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Action required' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'My Issues' })).toBeVisible();

    await expect(page.getByRole('button', { name: 'User Related' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'All Issues' })).toBeVisible();

    await expect(page.locator('a[href="/compose"]')).toBeVisible();

    await expectNoPageErrors(pageErrors);
  });

  test('chat page renders conversation list and main area', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/chat');
    await expect(page).toHaveTitle(/Chat - HAICO/);

    await expect(page.locator('#chat-conv-list')).toBeVisible();
    await expect(page.locator('#chat-main')).toBeVisible();
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'chat');
    await expect(page.locator('button[data-action="new-chat"]')).toBeVisible();

    await expectNoPageErrors(pageErrors);
  });

  test('compose page renders project form fields', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/compose');
    await expect(page).toHaveTitle(/Compose - HAICO/);

    await expect(page.locator('#global-compose-project')).toBeVisible();
    await expect(page.locator('#global-compose-to')).toBeVisible();
    await expect(page.locator('#global-compose-subject')).toBeVisible();
    await expect(page.locator('#global-compose-body')).toBeVisible();
    await expect(page.locator('#global-compose-send')).toBeVisible();


    await expectNoPageErrors(pageErrors);
  });
});
