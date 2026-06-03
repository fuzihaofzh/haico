import { expect, test } from './fixtures';
import { expectNoPageErrors, trackPageErrors } from './helpers/page-health';

test.describe('admin pages', () => {
  test('global-settings page renders log retention, event log toggle, and remote instances', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/admin/global-settings');

    await expect(page.locator('#admin-view-panel')).toBeVisible();
    await expect(page.locator('#log-retention-days')).toBeVisible();
    await expect(page.locator('#event-log-toggle')).toBeVisible();
    await expect(page.locator('#remote-instances-settings')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Global Settings' })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'admin');

    await expectNoPageErrors(pageErrors);
  });

  test('system page renders status, stuck agents, and maintenance sections', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/admin/system');

    await expect(page.locator('#admin-view-panel')).toBeVisible();
    await expect(page.locator('#system-status-overview')).toBeVisible();
    await expect(page.locator('#reset-stuck-agents-btn')).toBeVisible();
    await expect(page.locator('#run-maintenance-btn')).toBeVisible();
    await expect(page.getByRole('link', { name: 'System' })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', 'admin');

    await expectNoPageErrors(pageErrors);
  });
});

test.describe('auth pages', () => {
  test('login page renders form fields', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    // Clear auth cookie so the login page is accessible
    await page.context().clearCookies();
    await page.goto('/login?manual=1');

    await expect(page).toHaveTitle(/Login/);
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#login-form button[type="submit"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Register' })).toHaveAttribute('href', '/register');

    await expectNoPageErrors(pageErrors);
  });

  test('register page renders form fields', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.context().clearCookies();
    await page.goto('/register');

    await expect(page).toHaveTitle(/Register/);
    await expect(page.locator('#register-form')).toBeVisible();
    await expect(page.locator('#register-form #username')).toBeVisible();
    await expect(page.locator('#display_name')).toBeVisible();
    await expect(page.locator('#register-form #password')).toBeVisible();
    await expect(page.locator('#confirm')).toBeVisible();
    await expect(page.locator('#register-form button[type="submit"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Login' })).toHaveAttribute('href', '/login');

    await expectNoPageErrors(pageErrors);
  });

  test('change-password page renders form fields', async ({ page }) => {
    const pageErrors = trackPageErrors(page);

    await page.goto('/change-password');

    await expect(page).toHaveTitle(/Change Password/);
    await expect(page.locator('#change-password-form')).toBeVisible();
    await expect(page.locator('#current')).toBeVisible();
    await expect(page.locator('#change-password-form #password')).toBeVisible();
    await expect(page.locator('#confirm')).toBeVisible();
    await expect(page.locator('#change-password-form button[type="submit"]')).toBeVisible();

    await expectNoPageErrors(pageErrors);
  });
});
