(async function initDashboardSidebar() {
  const { h, html } = window;
  if (typeof h !== 'function' || typeof html !== 'function') {
    console.error('[HAICO] dashboard sidebar requires shared h/html helpers');
    return;
  }

  const host = document.querySelector('[data-dashboard-sidebar]');
  if (!host) return;

  const currentPage = document.body?.dataset?.dashboardPage || window.location.pathname.replace(/^\//, '') || 'inbox';

  // Fetch current user to determine admin visibility
  let isAdmin = false;
  try {
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const meData = await meRes.json();
      isAdmin = (meData.user?.role || meData.role) === 'admin';
    }
  } catch { /* ignore — sidebar still renders without admin entry */ }

  const items = [
    {
      page: 'overview',
      href: '/overview',
      label: 'Overview',
      icon: '<path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    },
    {
      page: 'inbox',
      href: '/inbox',
      label: 'Inbox',
      icon: '<path d="M21.75 6.75V17.25C21.75 18.4926 20.7426 19.5 19.5 19.5H4.5C3.25736 19.5 2.25 18.4926 2.25 17.25V6.75M21.75 6.75C21.75 5.50736 20.7426 4.5 19.5 4.5H4.5C3.25736 4.5 2.25 5.50736 2.25 6.75M21.75 6.75V6.99271C21.75 7.77405 21.3447 8.49945 20.6792 8.90894L13.1792 13.5243C12.4561 13.9694 11.5439 13.9694 10.8208 13.5243L3.32078 8.90894C2.65535 8.49945 2.25 7.77405 2.25 6.99271V6.75" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    },
    {
      page: 'chat',
      href: '/chat',
      label: 'Chat',
      icon: '<path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    },
    {
      page: 'projects',
      href: '/projects',
      label: 'Projects',
      icon: '<path d="M2.25 12.75V12C2.25 10.7574 3.25736 9.75 4.5 9.75H19.5C20.7426 9.75 21.75 10.7574 21.75 12V12.75M13.0607 6.31066L10.9393 4.18934C10.658 3.90804 10.2765 3.75 9.87868 3.75H4.5C3.25736 3.75 2.25 4.75736 2.25 6V18C2.25 19.2426 3.25736 20.25 4.5 20.25H19.5C20.7426 20.25 21.75 19.2426 21.75 18V9C21.75 7.75736 20.7426 6.75 19.5 6.75H14.1213C13.7235 6.75 13.342 6.59197 13.0607 6.31066Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    },
    {
      page: 'usage',
      href: '/usage',
      label: 'Usage',
      icon: '<path d="M7.5 14.25V16.5M10.5 12V16.5M13.5 9.75V16.5M16.5 7.5V16.5M6 20.25H18C19.2426 20.25 20.25 19.2426 20.25 18V6C20.25 4.75736 19.2426 3.75 18 3.75H6C4.75736 3.75 3.75 4.75736 3.75 6V18C3.75 19.2426 4.75736 20.25 6 20.25Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    },
  ];

  // Admin entry — only shown to admin users; pushed to bottom before Settings
  if (isAdmin) {
    items.push({
      page: 'admin',
      href: '/admin/users',
      label: 'Admin',
      extraClass: 'sidebar-nav-admin',
      icon: '<path d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    });
  }

  items.push({
    page: 'settings',
    href: '/settings',
    label: 'Settings',
    extraClass: 'sidebar-nav-settings',
    icon: '<path d="M9.59356 3.94014C9.68397 3.39768 10.1533 3.00009 10.7033 3.00009H13.2972C13.8472 3.00009 14.3165 3.39768 14.4069 3.94014L14.6204 5.22119C14.6828 5.59523 14.9327 5.9068 15.2645 6.09045C15.3387 6.13151 15.412 6.17393 15.4844 6.21766C15.8095 6.41393 16.2048 6.47495 16.5604 6.34175L17.7772 5.88587C18.2922 5.69293 18.8712 5.9006 19.1462 6.37687L20.4432 8.6233C20.7181 9.09957 20.6085 9.70482 20.1839 10.0544L19.1795 10.8812C18.887 11.122 18.742 11.4938 18.7491 11.8726C18.7498 11.915 18.7502 11.9575 18.7502 12.0001C18.7502 12.0427 18.7498 12.0852 18.7491 12.1275C18.742 12.5064 18.887 12.8782 19.1795 13.119L20.1839 13.9458C20.6085 14.2953 20.7181 14.9006 20.4432 15.3769L19.1462 17.6233C18.8712 18.0996 18.2922 18.3072 17.7772 18.1143L16.5604 17.6584C16.2048 17.5252 15.8095 17.5862 15.4844 17.7825C15.412 17.8262 15.3387 17.8686 15.2645 17.9097C14.9327 18.0933 14.6828 18.4049 14.6204 18.7789L14.4069 20.06C14.3165 20.6024 13.8472 21 13.2972 21H10.7033C10.1533 21 9.68397 20.6024 9.59356 20.06L9.38011 18.7789C9.31771 18.4049 9.06783 18.0933 8.73601 17.9097C8.66135 17.8686 8.58787 17.8262 8.51561 17.7825C8.1905 17.5862 7.79516 17.5252 7.4396 17.6584L6.22284 18.1143C5.7078 18.3072 5.1288 18.0996 4.85383 17.6233L3.55681 15.3769C3.28184 14.9006 3.3915 14.2953 3.81614 13.9458L4.82052 13.119C5.11298 12.8782 5.25802 12.5064 5.25089 12.1275C5.2502 12.0852 5.24984 12.0427 5.24984 12.0001C5.24984 11.9575 5.2502 11.915 5.25089 11.8726C5.25802 11.4938 5.11298 11.122 4.82052 10.8812L3.81614 10.0544C3.3915 9.70482 3.28184 9.09957 3.55681 8.6233L4.85383 6.37687C5.1288 5.9006 5.7078 5.69293 6.22284 5.88587L7.4396 6.34175C7.79516 6.47495 8.1905 6.41393 8.51561 6.21766C8.58787 6.17393 8.66135 6.13151 8.73601 6.09045C9.06783 5.9068 9.31771 5.59523 9.38011 5.22119L9.59356 3.94014Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  });

  const links = items.map((item) => {
    const active = item.page === currentPage ? ' active' : '';
    const extra = item.extraClass ? ' ' + item.extraClass : '';
    return h`<a href="${item.href}" class="sidebar-nav-item${extra}${active}" data-sidebar-view="${item.page}" aria-label="${item.label}">
      <span class="sidebar-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none">${html(item.icon)}</svg></span>
      <span class="sidebar-nav-label">${item.label}</span>
    </a>`;
  }).join('');

  host.outerHTML = h`<nav class="vertical-sidebar" aria-label="Dashboard navigation">
    <a href="/overview" class="sidebar-logo" aria-label="HAICO Dashboard"><img src="/public/brand/haico-mark.svg" alt=""></a>
    ${html(links)}
  </nav>`;
})();
