import { expect, test } from './fixtures';
import { expectNoPageErrors, trackPageErrors } from './helpers/page-health';
import { createE2EProject, deleteE2EProject } from './helpers/projects';

type WorkerProjectSnapshot = {
  projectId: string;
  subscriberCount: number;
  state: string;
  socketState: string;
  hasReconnectTimer: boolean;
  hasCloseTimer: boolean;
};

type WorkerSnapshot = {
  sharedWorkerDisabled?: boolean;
  clientCount: number;
  projectCount: number;
  projects: WorkerProjectSnapshot[];
};

async function getWorkerSnapshot(page: import('@playwright/test').Page): Promise<WorkerSnapshot> {
  return page.evaluate(async () => {
    const client = (window as any).HAICOProjectEventsClient;
    if (!client || typeof client._debugSnapshot !== 'function') {
      throw new Error('HAICOProjectEventsClient debug snapshot is unavailable');
    }
    return client._debugSnapshot(2000);
  });
}

async function getProjectSnapshot(
  page: import('@playwright/test').Page,
  projectId: string
): Promise<WorkerProjectSnapshot | undefined> {
  const snapshot = await getWorkerSnapshot(page);
  return snapshot.projects.find((project) => project.projectId === projectId);
}

test('SharedWorker shares one project event socket across same-project pages', async ({ context, page, request }) => {
  const project = await createE2EProject(request);
  const firstPageErrors = trackPageErrors(page);
  const secondPage = await context.newPage();
  const secondPageErrors = trackPageErrors(secondPage);

  try {
    await page.goto(`/project/${project.id}`);
    await expect(page.locator('#project-title')).toContainText(project.name);
    await expect.poll(async () => {
      const snapshot = await getProjectSnapshot(page, project.id);
      return snapshot ? `${snapshot.subscriberCount}:${snapshot.socketState}` : 'missing';
    }).toBe('1:OPEN');

    await secondPage.goto(`/project/${project.id}/agents`);
    await expect(secondPage.locator('#agent-list')).toBeVisible();

    await expect.poll(async () => {
      const snapshot = await getProjectSnapshot(page, project.id);
      return snapshot ? `${snapshot.subscriberCount}:${snapshot.socketState}` : 'missing';
    }).toBe('2:OPEN');

    const sharedSnapshot = await getWorkerSnapshot(page);
    expect(sharedSnapshot.sharedWorkerDisabled).not.toBe(true);
    expect(sharedSnapshot.projectCount).toBe(1);

    await secondPage.close();
    await expect.poll(async () => {
      const snapshot = await getProjectSnapshot(page, project.id);
      return snapshot ? `${snapshot.subscriberCount}:${snapshot.socketState}` : 'missing';
    }).toBe('1:OPEN');

    await expectNoPageErrors(firstPageErrors);
    await expectNoPageErrors(secondPageErrors);
  } finally {
    if (!secondPage.isClosed()) await secondPage.close();
    await deleteE2EProject(request, project.id);
  }
});
