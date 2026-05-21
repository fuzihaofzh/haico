import { test as base, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

const E2E_ADMIN_USERNAME = 'haico_default_admin';
const E2E_ADMIN_PASSWORD = process.env.HAICO_E2E_ADMIN_PASSWORD || 'haico-e2e-password';

async function loginE2EAdmin(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/auth/login', {
    data: {
      username: E2E_ADMIN_USERNAME,
      password: E2E_ADMIN_PASSWORD,
    },
  });
  await expect(response, await response.text()).toBeOK();
  const body = await response.json();
  expect(body.token).toBeTruthy();
  return body.token;
}

async function authenticateBrowserContext(
  request: APIRequestContext,
  context: BrowserContext,
  baseURL: string | undefined
): Promise<void> {
  const token = await loginE2EAdmin(request);
  expect(baseURL).toBeTruthy();
  await context.addCookies([{
    name: 'haico-auth',
    value: token,
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

export const test = base.extend<{ authenticated: void }>({
  authenticated: [async ({ request, context, baseURL }, use) => {
    await authenticateBrowserContext(request, context, baseURL);
    await use();
  }, { auto: true }],
});

export { expect };
