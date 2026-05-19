import { getCachedJson, removeCached, setCachedJson } from './dashboard-storage.js';

export const PROJECTS_CACHE_KEY = 'haico.dashboard.projects.v1';
export const PROJECTS_CACHE_TTL_MS = 15000;
export const REMOTE_OPTIONS_CACHE_KEY = 'haico.dashboard.remoteOptions.v1';

let projectsById = {};
let projectsList = [];
let loadPromise = null;
const listeners = new Set();

function indexProjects(projects) {
  projectsList = Array.isArray(projects) ? projects : [];
  projectsById = Object.fromEntries(projectsList.map((project) => [project.id, project]));
  return projectsList;
}

function emitProjectsUpdated(projects) {
  window.dispatchEvent(new CustomEvent('haico:dashboard-projects-updated', { detail: { projects } }));
  listeners.forEach((listener) => {
    try { listener(projects); } catch (error) { console.error('Dashboard project listener failed', error); }
  });
}

function toCachedProjectSummary(project) {
  if (!project || !project.id) return null;
  return {
    id: project.id,
    name: project.name || '',
    status: project.status || '',
    is_remote: Boolean(project.is_remote),
    can_manage: Boolean(project.can_manage),
    can_view: project.can_view !== false,
    remote_instance_id: project.remote_instance_id || null,
    remote_project_id: project.remote_project_id || null,
    remote_instance_name: project.remote_instance_name || '',
    remote_base_url: project.remote_base_url || '',
    stats: project.stats || null,
    owner: project.owner ? {
      id: project.owner.id || null,
      username: project.owner.username || '',
      display_name: project.owner.display_name || '',
    } : null,
  };
}

function cacheProjectSummaries(projects) {
  const summaries = projects.map(toCachedProjectSummary).filter(Boolean);
  setCachedJson(PROJECTS_CACHE_KEY, { projects: summaries });
}

export function getCachedDashboardProjects() {
  const cached = getCachedJson(PROJECTS_CACHE_KEY, PROJECTS_CACHE_TTL_MS);
  if (!cached || !Array.isArray(cached.projects)) return null;
  return indexProjects(cached.projects);
}

export async function loadDashboardProjects(options = {}) {
  const force = options.force === true;
  if (!force && projectsList.length) return projectsList;
  if (!force) {
    const cached = getCachedDashboardProjects();
    if (cached) return cached;
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const [localRes, remoteRes] = await Promise.all([
      fetch('/api/projects?with_stats=1', { headers: apiHeaders() }),
      fetch('/api/remote-projects', { headers: apiHeaders() }).catch(() => null),
    ]);
    if (!localRes.ok) throw new Error('Failed to load projects');
    const localProjects = await localRes.json();
    const remotePayload = remoteRes && remoteRes.ok ? await remoteRes.json().catch(() => ({ projects: [] })) : { projects: [] };
    const remoteProjects = Array.isArray(remotePayload.projects) ? remotePayload.projects : [];
    const projects = indexProjects([].concat(localProjects || [], remoteProjects));
    cacheProjectSummaries(projects);
    emitProjectsUpdated(projects);
    return projects;
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

export function getDashboardProjectById(projectId) {
  return projectsById[projectId] || null;
}

export function getLocalDashboardProjects() {
  return Object.values(projectsById || {}).filter((project) => project && !project.is_remote);
}

export function invalidateDashboardProjects(options = {}) {
  projectsList = [];
  projectsById = {};
  removeCached(PROJECTS_CACHE_KEY);
  if (options.invalidateRemoteOptions) removeCached(REMOTE_OPTIONS_CACHE_KEY);
  window.dispatchEvent(new CustomEvent('haico:dashboard-projects-invalidated'));
}

export function subscribeDashboardProjects(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
