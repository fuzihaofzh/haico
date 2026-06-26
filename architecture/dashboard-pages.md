# Dashboard Pages

## Sidebar Navigation

Order: Overview → Inbox → Chat → Projects → Usage → Settings → Admin

_Admin entry only rendered when user role is admin_

## Pages

| Route | HTML | JS | Description |
|---|---|---|---|
| `/overview` | `overview.html` | `dashboard-overview.js` | Default landing page. Stats bar, quick links, active projects, recent activity |
| `/inbox` | `inbox.html` | `dashboard-inbox.js` | Inbox list with Gmail-style issue preview |
| `/chat` | `chat.html` | `dashboard-chat.js` | AI chat assistant (extracted from inbox) |
| `/compose` | `compose.html` | `compose.js` | New issue form. Entry point in Inbox header |
| `/issue/:id` | `issue.html` | `issue-detail.js` | Full-page issue detail (replaces modal) |
| `/projects` | `projects.html` | `dashboard-projects.js` | Project list |
| `/project/:id` | `project/overview.html` | `project/shell.js` + `project/overview.js` | Single project overview |
| `/project/:id/agents` | `project/agents.html` | `project/shell.js` + `project/agents.js` | Project agents |
| `/project/:id/issues` | `project/issues.html` | `project/shell.js` + `project/issues.js` | Project issues |
| `/project/:id/activity` | `project/activity.html` | `project/shell.js` + `project/activity.js` | Project activity stream |
| `/project/:id/git` | `project/git.html` | `project/shell.js` + `project/git.js` | Git log |
| `/project/:id/knowledge` | `project/knowledge.html` | `project/shell.js` + `project/knowledge.js` | Knowledge base |
| `/project/:id/files` | `project/files.html` | `project/shell.js` + `project/files.js` | File browser |
| `/project/:id/workflow` | `project/workflow.html` | `project/shell.js` + `project/workflow.js` | Workflow graph |
| `/project/:id/sharing` | `project/sharing.html` | `project/shell.js` + `project/sharing.js` | Project sharing/members |
| `/project/:id/operations-console` | `operations-console.html` | `operations-console.js` | Operations console |
| `/projects/new` | `projects-new.html` | `project-new.js` | Create new project |
| `/usage` | `usage.html` | `usage.js` | Usage/cost dashboard |
| `/settings` | `settings/general.html` | `settings/general.js` | Settings |
| `/admin/users` | `views/admin/users.ts` (SSR) | `shared/admin-htmx.js` | User management (admin-only, htmx) |
| `/admin/global-settings` | `views/admin/settings.ts` (SSR) | `shared/admin-htmx.js` | Global settings + remote instances (admin-only, htmx) |
| `/admin/system` | `views/admin/system.ts` (SSR) | `shared/admin-htmx.js` | System status + maintenance (admin-only, htmx) |

## Route Conventions

- Collection (list) routes use plural: `/projects`, `/issues`
- Single-entity routes use singular: `/project/:id`, `/issue/:id`
- API routes remain RESTful plural: `/api/projects/:id`
- WebSocket routes remain as-is: `/ws/projects/:id/events`

## Default Landing Page

Configurable per user via Settings → Navigation. Stored in `user_settings` table (key: `default_landing_page`). Priority: query param `?view=` → user DB preference → fallback `/overview`. Valid values: `overview`, `inbox`, `chat`, `projects`.

## Shared Infrastructure

- `dashboard-core.js`: `initDashboardPage()`, `loadDashboardProjects()`, `loadDashboardSummary()`, `setupDashboardWS()`, `switchView()`
- `common.js`: `buildProjectPageHref()`, `buildIssueApiPath()`, `buildProjectApiPath()`, `h` tagged template, `html()`, `esc()`, `apiHeaders()`
- `dashboard-sidebar.js`: Sidebar nav generation with active-state highlighting
- `dashboard-project-store.js`: Shared project data cache + `subscribeDashboardProjects()` reactive updates

## Page Pattern

Each dashboard page follows:
```
<body class="dashboard-shell" data-dashboard-page="X">
  <div data-dashboard-sidebar> <!-- placeholder, hydrated by sidebar.js -->
  <header class="dashboard-header">
    <div class="header-left">...</div>
    <div class="header-right">...</div>
  </header>
  <main id="main-content">...</main>
</body>
```

### Htmx Fragment Endpoints

Admin pages (`/admin/*`) use htmx for server-state interactions. The first-paint shell is SSR via `renderAdminShell()` in `src/views/shell.ts`; subsequent interactions hit `/ui/admin/*` fragment endpoints that return `<main>`-internal HTML fragments (no shell, no `<html>`/`<head>`/`<body>`). Errors in the `/ui/admin` scope return HTML error fragments + 4xx/5xx (not JSON), via a scope-level `setErrorHandler`. See `src/routes/ui-admin.ts`.

Project sub-pages additionally share `project/shell.js` which:
- Extracts `projectId` from URL via `getProjectIdFromPath()`
- Loads project detail, agents, and sidebar state
- Provides `projectApiPath()`, `buildProjectPageHref()` wrappers
