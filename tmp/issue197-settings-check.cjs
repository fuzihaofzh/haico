const { chromium } = require('playwright');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const skipDelete = process.env.SKIP_DELETE === '1';
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const commandProfileRequests = [];
  const commandProfileResponses = [];
  const profileName = `QA Profile ${Date.now()}`;

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('request', (request) => {
    if (request.url().includes('/api/command-profiles')) {
      commandProfileRequests.push({
        method: request.method(),
        url: request.url(),
      });
    }
  });
  page.on('response', async (response) => {
    if (response.url().includes('/api/command-profiles')) {
      let body = '';
      try {
        body = await response.text();
      } catch {}
      commandProfileResponses.push({
        status: response.status(),
        url: response.url(),
        body,
      });
    }
  });

  async function visible(selector) {
    return page.locator(selector).evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  }

  async function switchAndCheck(view, panelSelector) {
    console.log(`STEP switch ${view}`);
    await page.click(`.sidebar-nav-item[data-sidebar-view="${view}"]`);
    await page.waitForFunction((expected) => document.body.dataset.dashboardView === expected, view);
    const active = await page.locator('.sidebar-nav-item.active').getAttribute('data-sidebar-view');
    assert(active === view, `导航高亮不是 ${view}，实际为 ${active}`);
    if (panelSelector) {
      assert(await visible(panelSelector), `${panelSelector} 未显示`);
    }
  }

  console.log('STEP goto login');
  await page.goto('http://localhost:4570/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], input[type="text"]', 'qaadmin');
  await page.fill('input[name="password"], input[type="password"]', 'test1234');
  await Promise.all([
    page.waitForURL('http://localhost:4570/'),
    page.click('button[type="submit"], button:has-text("Login")'),
  ]);
  await page.waitForSelector('body.dashboard-shell');

  console.log('STEP verify desktop settings');
  assert((await page.locator('#drawer').count()) === 0, '首页仍存在 drawer');
  assert((await page.locator('#overlay').count()) === 0, '首页仍存在 overlay');
  await switchAndCheck('settings', '#settings-view-panel');
  assert((await page.locator('#settings-view-panel h2').textContent()) === 'Settings', 'Settings 标题错误');
  assert(await visible('#theme-select'), 'Theme 选择器未显示');
  assert(await visible('.notif-sound-toggle'), 'Notification Sound 开关未显示');
  assert(await visible('[data-command-profiles-root]'), 'Command Profiles 区域未显示');

  console.log('STEP theme toggle');
  const originalTheme = await page.evaluate(() => localStorage.getItem('haico-theme'));
  const nextTheme = originalTheme === 'dracula' ? 'solarized-light' : 'dracula';
  await page.selectOption('#theme-select', nextTheme);
  await page.waitForFunction((theme) => localStorage.getItem('haico-theme') === theme, nextTheme);
  const appliedTheme = await page.evaluate(() => ({
    stored: localStorage.getItem('haico-theme'),
    selected: document.getElementById('theme-select').value,
  }));
  assert(appliedTheme.stored === nextTheme, 'Theme localStorage 未更新');
  assert(appliedTheme.selected === nextTheme, 'Theme select 未更新');

  console.log('STEP notification sound toggle');
  const soundBefore = await page.evaluate(() => ({
    value: localStorage.getItem('haico-notification-sound'),
    on: document.querySelector('.notif-sound-toggle').classList.contains('on'),
  }));
  await page.click('.notif-sound-toggle');
  await page.waitForFunction(
    (prevValue, prevOn) => {
      const el = document.querySelector('.notif-sound-toggle');
      return localStorage.getItem('haico-notification-sound') !== prevValue
        || el.classList.contains('on') !== prevOn;
    },
    soundBefore.value,
    soundBefore.on
  );
  await page.click('.notif-sound-toggle');
  await page.waitForFunction(
    (prevOn) => document.querySelector('.notif-sound-toggle').classList.contains('on') === prevOn,
    soundBefore.on
  );

  console.log('STEP command profiles crud');
  await page.fill('[data-command-profile-row="__new__"] [data-field="name"]', profileName);
  await page.fill('[data-command-profile-row="__new__"] [data-field="command"]', 'cld --model qa-test');
  await page.selectOption('[data-command-profile-row="__new__"] [data-field="type"]', 'claude');
  await page.click('[data-command-profile-row="__new__"] [data-command-profile-action="create"]');
  await page.waitForFunction((name) =>
    Array.from(document.querySelectorAll('[data-command-profile-row]')).some((el) => {
      if (el.getAttribute('data-command-profile-row') === '__new__') return false;
      const input = el.querySelector('[data-field="name"]');
      return input && input.value === name;
    }),
    profileName
  );
  let profiles = await page.evaluate(async () => {
    const res = await fetch('/api/command-profiles', { headers: { 'Content-Type': 'application/json' } });
    return res.json();
  });
  let profile = profiles.profiles.find((p) => p.name === profileName);
  assert(profile, 'Command profile 新增失败');

  const rowSelector = `[data-command-profile-row="${profile.id}"]`;
  await page.fill(`${rowSelector} [data-field="command"]`, 'cld --model qa-test-2');
  await page.selectOption(`${rowSelector} [data-field="type"]`, 'codex');
  await page.click(`${rowSelector} [data-command-profile-action="save"]`);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.querySelector('[data-field="command"]')?.value === 'cld --model qa-test-2',
    rowSelector
  );
  profiles = await page.evaluate(async () => {
    const res = await fetch('/api/command-profiles', { headers: { 'Content-Type': 'application/json' } });
    return res.json();
  });
  profile = profiles.profiles.find((p) => p.id === profile.id);
  assert(profile.command === 'cld --model qa-test-2', 'Command profile 编辑失败');
  assert(profile.type === 'codex', 'Command profile 类型更新失败');

  if (!skipDelete) {
    const requestCountBeforeDelete = commandProfileRequests.length;
    await page.click(`${rowSelector} [data-command-profile-action="delete"]`);
    await page.waitForSelector('#confirm-overlay', { state: 'visible' });
    await page.click('#confirm-ok');
    try {
      await page.waitForFunction((selector) => !document.querySelector(selector), rowSelector, { timeout: 10000 });
    } catch (error) {
      const requestsAfterDelete = commandProfileRequests.slice(requestCountBeforeDelete);
      const responsesAfterDelete = commandProfileResponses.filter((item) =>
        item.url.includes('/api/command-profiles/')
      );
      throw new Error(
        `删除后行未消失；新增请求=${JSON.stringify(requestsAfterDelete)}；响应=${JSON.stringify(responsesAfterDelete)}`
      );
    }
    await page.waitForFunction(async (name) => {
      const res = await fetch('/api/command-profiles', { headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      return !data.profiles.some((p) => p.name === name);
    }, profileName);
  } else {
    console.log('STEP skip delete for downstream checks');
  }

  console.log('STEP change password entry');
  await Promise.all([
    page.waitForURL('http://localhost:4570/change-password'),
    page.click('a.settings-action-link[href="/change-password"]'),
  ]);
  await page.waitForSelector('body');
  assert((await page.locator('body').textContent()).includes('Change Password'), 'Change Password 页面不可访问');

  console.log('STEP go back');
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.dashboard-shell');
  await switchAndCheck('inbox', '#notifications-panel');
  await switchAndCheck('projects', '#projects-view-panel');
  await switchAndCheck('usage');
  await switchAndCheck('settings', '#settings-view-panel');

  console.log('STEP mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:4570/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.dashboard-shell');
  await switchAndCheck('settings', '#settings-view-panel');
  const mobileMetrics = await page.evaluate(() => ({
    bodyView: document.body.dataset.dashboardView,
    active: document.querySelector('.sidebar-nav-item.active')?.getAttribute('data-sidebar-view'),
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(mobileMetrics.bodyView === 'settings', '窄屏 Settings 视图未激活');
  assert(mobileMetrics.active === 'settings', '窄屏导航高亮错误');
  assert(mobileMetrics.scrollWidth <= mobileMetrics.innerWidth + 2, '窄屏出现横向溢出');
  await switchAndCheck('inbox', '#notifications-panel');
  await switchAndCheck('projects', '#projects-view-panel');
  await switchAndCheck('settings', '#settings-view-panel');

  console.log('STEP logout');
  await Promise.all([
    page.waitForURL('http://localhost:4570/login'),
    page.click('a.settings-action-link-danger'),
  ]);

  assert(consoleErrors.length === 0, `存在 console error: ${consoleErrors.join(' | ')}`);
  assert(pageErrors.length === 0, `存在 page error: ${pageErrors.join(' | ')}`);

  console.log(JSON.stringify({
    ok: true,
    skipDelete,
    theme: appliedTheme,
    mobileMetrics,
    commandProfileRequests,
    commandProfileResponses,
  }, null, 2));

  await browser.close();
}

main().catch((error) => {
  console.error('RUNNER_FAILED');
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
