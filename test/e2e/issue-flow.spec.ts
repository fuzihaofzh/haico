import { expect, test } from './fixtures';
import { trackPageErrors, expectNoPageErrors } from './helpers/page-health';
import { createE2EProject, deleteE2EProject } from './helpers/projects';
import { createE2EIssue } from './helpers/issues';

test.describe('issue flow', () => {
  test('issue create-view-comment flow works end-to-end', async ({ page, request }) => {
    const project = await createE2EProject(request);
    const issue = await createE2EIssue(request, project.id, {
      body: 'E2E flow: verify the full issue lifecycle',
    });
    const pageErrors = trackPageErrors(page);

    try {
      // Step 1: View the issue via /issues/:id
      await page.goto(`/issues/${issue.id}`);

      await expect(page.locator('#issue-detail-content')).toBeVisible();
      await expect(page.locator('#ir-title-display')).toContainText(issue.title);
      await expect(page.locator('#ir-body-display')).toContainText('E2E flow: verify the full issue lifecycle');
      await expect(page.locator('#ir-detail-status')).toBeVisible();
      await expect(page.locator('#ir-comment-input')).toBeVisible();

      // Step 2: Add a comment via the API
      const commentResp = await request.post(`/api/issues/${issue.id}/comments`, {
        data: { author_id: 'user', body: 'E2E test comment from flow' },
      });
      await expect(commentResp, await commentResp.text()).toBeOK();

      // Step 3: Verify comment appears on the page after reload
      await page.reload();
      await expect(page.locator('#issue-detail-content')).toBeVisible();
      await expect(page.locator('#issue-detail-content')).toContainText('E2E test comment from flow', { timeout: 5000 });

      // Step 4: View issue via project-scoped URL
      await page.goto(`/project/${project.id}/issues/${issue.number}`);

      await expect(page.locator('#issue-detail-content')).toBeVisible();
      await expect(page.locator('#ir-title-display')).toContainText(issue.title);

      await expectNoPageErrors(pageErrors);
    } finally {
      await deleteE2EProject(request, project.id);
    }
  });
});
