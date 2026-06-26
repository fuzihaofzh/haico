import { h, html } from '../html';

const ADMIN_NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/global-settings', label: 'Global Settings' },
  { href: '/admin/system', label: 'System' },
];

/** Shared admin page header (eyebrow / title / description). */
export function renderAdminPageHeader(): string {
  return h`<div class="settings-page-header">
    <div>
      <div class="settings-page-eyebrow">Administration</div>
      <h2>Admin</h2>
      <p>Manage users, global settings, and system operations.</p>
    </div>
  </div>`;
}

/** Admin section nav with active-state highlighting driven by current path. */
export function renderAdminNav(path: string): string {
  const links = ADMIN_NAV_ITEMS.map((item) => {
    if (path === item.href) {
      return h`<a href="${item.href}" class="active" aria-current="page">${item.label}</a>`;
    }
    return h`<a href="${item.href}">${item.label}</a>`;
  });
  return h`<nav class="settings-section-nav" aria-label="Admin sections">${html(
    links.join(''),
  )}</nav>`;
}
