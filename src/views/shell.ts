import { h, html } from './html';

export interface AdminShellOptions {
  title: string;
  /** Inner HTML of <main id="main-content">. */
  body: string;
}

/**
 * Full HTML document for an admin page. Keeps the sidebar/header skeletons
 * (hydrated client-side by dashboard-sidebar.js) and loads htmx + the admin
 * htmx event listeners. Page content is SSR-injected via `body`.
 */
export function renderAdminShell({ title, body }: AdminShellOptions): string {
  return h`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/public/brand/haico-mark.svg">
  <link rel="icon" type="image/x-icon" href="/public/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32.png">
  <link rel="apple-touch-icon" href="/public/apple-touch-icon.png">
  <script src="/public/js/shared/theme.js"></script>
  <link rel="stylesheet" href="/public/css/index.css">
</head>
<body class="dashboard-shell" data-dashboard-page="admin">
  <div data-dashboard-sidebar>
    <nav class="vertical-sidebar dashboard-sidebar-skeleton" aria-hidden="true">
      <span class="sidebar-logo sidebar-skeleton-logo"></span>
      <span class="sidebar-nav-item sidebar-skeleton-item"><span class="sidebar-skeleton-icon"></span><span class="sidebar-skeleton-label"></span></span>
      <span class="sidebar-nav-item sidebar-skeleton-item"><span class="sidebar-skeleton-icon"></span><span class="sidebar-skeleton-label"></span></span>
      <span class="sidebar-nav-item sidebar-skeleton-item"><span class="sidebar-skeleton-icon"></span><span class="sidebar-skeleton-label"></span></span>
      <span class="sidebar-nav-item sidebar-nav-settings sidebar-skeleton-item"><span class="sidebar-skeleton-icon"></span><span class="sidebar-skeleton-label"></span></span>
    </nav>
  </div>

  <header>
    <div class="header-right">
      <span class="header-user-skeleton" aria-hidden="true">
        <span class="header-skeleton-sound"></span>
        <span class="header-skeleton-avatar"></span>
      </span>
    </div>
  </header>

  <main id="main-content" class="container">${html(body)}</main>

  <script src="/public/js/shared/common.js"></script>
  <script src="/public/js/components/dashboard-sidebar.js"></script>
  <script defer src="/public/vendor/htmx.min.js"></script>
  <script type="module" src="/public/js/shared/admin-htmx.js"></script>
</body>
</html>`;
}
