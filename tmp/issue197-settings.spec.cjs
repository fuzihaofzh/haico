const { test, expect, chromium } = require('playwright/test');

test.setTimeout(120000);

test('issue197 settings page regression', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  async function isVisible(selector) {
    return page.locator(selector).evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  }

  async function dashboardView() {
    return page.locator('body').evaluate((el) => el.dataset.dashboardView);
  }

  async function activeNav() {
    return page.locator('.sidebar-nav-item.active').getAttribute('data-sidebar-view');
  }

  async function switchAndCheck(view, panelSelector) {
    await page.click(`.sidebar-nav-item[data-sidebar-view="${view}"]`);
    await page.waitForFunction((expected) => document.body.dataset.dashboardView === expected, view);
    await expect(page.locator('body')).toHaveAttribute('data-dashboard-view', view);
    await expect(page.locator('.sidebar-nav-item.active')).toHaveAttribute('data-sidebar-view', view);
    expect(await isVisible(panelSelector)).toBeTruthy();
  }

  await page.goto('http://localhost:4570/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], input[type="text"]', 'qaadmin');
  await page.fill('input[name="password"], input[type="password"]', 'test1234');
  await Promise.all([
    page.waitForURL('http://localhost:4570/'),
    page.click('button[type="submit"], button:has-text("Login")'),
  ]);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('body.dashboard-shell');

  expect(await dashboardView()).toBe('inbox');
  expect(await activeNav()).toBe('inbox');
  await expect(page.locator('#drawer')).toHaveCount(0);
  await expect(page.locator('#overlay')).toHaveCount(0);

  await switchAndCheck('settings', '#settings-view-panel');
  await expect(page.locator('#settings-view-panel h2')).toHaveText('Settings');
  expect(await isVisible('#theme-select')).toBeTruthy();
  expect(await isVisible('.notif-sound-toggle')).toBeTruthy();
  expect(await isVisible('[data-command-profiles-root]')).toBeTruthy();

  const originalTheme = await page.evaluate(() => localStorage.getItem('agentopia-theme'));
  const nextTheme = originalTheme === 'dracula' ? 'solarized-light' : 'dracula';
  await page.selectOption('#theme-select', nextTheme);
  await page.waitForFunction((theme) => localStorage.getItem('agentopia-theme') === theme, nextTheme);
  const appliedTheme = await page.evaluate(() => ({
    theme: localStorage.getItem('agentopia-theme'),
    value: document.getElementById('theme-select').value,
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  }));
  expect(appliedTheme.theme).toBe(nextTheme);
  expect(appliedTheme.value).toBe(nextTheme);
  expect(appliedTheme.bg.length).toBeGreaterThan(0);

  const soundBefore = await page.evaluate(() => ({
    value: localStorage.getItem('agentopia-notification-sound'),
    on: document.querySelector('.notif-sound-toggle').classList.contains('on'),
  }));
  await page.click('.notif-sound-toggle');
  await page.waitForTimeout(100);
  const soundAfterFirst = await page.evaluate(() => ({
    value: localStorage.getItem('agentopia-notification-sound'),
    on: document.querySelector('.notif-sound-toggle').classList.contains('on'),
  }));
  expect(
    soundAfterFirst.value !== soundBefore.value || soundAfterFirst.on !== soundBefore.on
  ).toBeTruthy();
  await page.click('.notif-sound-toggle');
  await page.waitForTimeout(100);
  const soundAfterSecond = await page.evaluate(() => ({
    value: localStorage.getItem('agentopia-notification-sound'),
    on: document.querySelector('.notif-sound-toggle').classList.contains('on'),
  }));
  expect(soundAfterSecond.on).toBe(soundBefore.on);

  await page.waitForSelector('[data-command-profile-row="__new__"]');
  await page.fill('[data-command-profile-row="__new__"] [data-field="name"]', 'QA Profile');
  await page.fill('[data-command-profile-row="__new__"] [data-field="command"]', 'cld --model qa-test');
  await page.selectOption('[data-command-profile-row="__new__"] [data-field="type"]', 'claude');
  await page.click('[data-command-profile-row="__new__"] [data-command-profile-action="create"]');
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[data-command-profile-row]')).some(
      (el) => el.getAttribute('data-command-profile-row') !== '__new__'
    )
  );
  let profiles = await page.evaluate(async () => {
    const res = await fetch('/api/command-profiles', {
      headers: { 'Content-Type': 'application/json' },
    });
    return res.json();
  });
  let qa = profiles.profiles.find((p) => p.name === 'QA Profile');
  expect(qa).toBeTruthy();
  expect(qa.command).toBe('cld --model qa-test');
  expect(qa.type).toBe('claude');

  const rowSelector = `[data-command-profile-row="${qa.id}"]`;
  await page.fill(`${rowSelector} [data-field="command"]`, 'cld --model qa-test-2');
  await page.selectOption(`${rowSelector} [data-field="type"]`, 'codex');
  await page.click(`${rowSelector} [data-command-profile-action="save"]`);
  await page.waitForTimeout(200);
  profiles = await page.evaluate(async () => {
    const res = await fetch('/api/command-profiles', {
      headers: { 'Content-Type': 'application/json' },
    });
    return res.json();
  });
  qa = profiles.profiles.find((p) => p.id === qa.id);
  expect(qa.command).toBe('cld --model qa-test-2');
  expect(qa.type).toBe('codex');

  await page.click(`${rowSelector} [data-command-profile-action="delete"]`);
  await page.waitForSelector('#confirm-overlay', { state: 'visible' });
  await page.click('#confirm-ok');
  await page.waitForFunction((selector) => !document.querySelector(selector), rowSelector);
  await expect
    .poll(async () => {
      const data = await page.evaluate(async () => {
        const res = await fetch('/api/command-profiles', {
          headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
      });
      return data.profiles.some((p) => p.name === 'QA Profile');
    })
    .toBe(false);
  profiles = await page.evaluate(async () => {
    const res = await fetch('/api/command-profiles', {
      headers: { 'Content-Type': 'application/json' },
    });
    return res.json();
  });
  qa = profiles.profiles.find((p) => p.name === 'QA Profile');
  expect(qa).toBeFalsy();

  await Promise.all([
    page.waitForURL('http://localhost:4570/change-password'),
    page.click('a.settings-action-link[href="/change-password"]'),
  ]);
  await expect(page.locator('body')).toContainText('Change Password');
  await page.goBack({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.dashboard-shell');

  await switchAndCheck('inbox', '#notifications-panel');
  await switchAndCheck('projects', '#projects-view-panel');
  await switchAndCheck('usage', '#usage-panel');
  await switchAndCheck('settings', '#settings-view-panel');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.dashboard-shell');
  await switchAndCheck('settings', '#settings-view-panel');
  const mobileMetrics = await page.evaluate(() => ({
    bodyView: document.body.dataset.dashboardView,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    active: document.querySelector('.sidebar-nav-item.active')?.getAttribute('data-sidebar-view'),
  }));
  expect(mobileMetrics.bodyView).toBe('settings');
  expect(mobileMetrics.active).toBe('settings');
  expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.innerWidth + 2);
  await switchAndCheck('inbox', '#notifications-panel');
  await switchAndCheck('projects', '#projects-view-panel');
  await switchAndCheck('settings', '#settings-view-panel');

  await Promise.all([
    page.waitForURL('http://localhost:4570/login'),
    page.click('a.settings-action-link-danger'),
  ]);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  console.log(JSON.stringify({
    ok: true,
    themeAfter: appliedTheme,
    mobileMetrics,
  }));

  await browser.close();
});
