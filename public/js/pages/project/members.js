let projectMembersData = [];
let projectMembersTemplatesPromise = null;
const PROJECT_MEMBERS_TEMPLATE_URL = '/public/templates/project-members.html?v=1';

function mergeOwnerIntoMembers(members) {
  const normalized = Array.isArray(members) ? [...members] : [];
  if (projectData?.owner?.id && !normalized.some((member) => member.user_id === projectData.owner.id)) {
    normalized.unshift({
      id: `owner-${projectData.owner.id}`,
      user_id: projectData.owner.id,
      username: projectData.owner.username,
      display_name: projectData.owner.display_name,
      user_role: projectData.owner.role,
      role: 'owner',
    });
  }
  return normalized.sort((a, b) => {
    if (a.role === 'owner' && b.role !== 'owner') return -1;
    if (a.role !== 'owner' && b.role === 'owner') return 1;
    return displayProjectUser(a).localeCompare(displayProjectUser(b), 'zh-Hans-CN');
  });
}

async function renderProjectMembers() {
  const list = document.getElementById('project-members-list');
  if (!list) return;

  const members = mergeOwnerIntoMembers(projectMembersData);
  if (!members.length) {
    list.innerHTML = '<div class="empty-state">No member information</div>';
    return;
  }

  const canManage = !!projectData?.can_manage;
  const isProjectOwner = (uid) => projectData?.owner?.id === uid;
  await ensureProjectMemberTemplatesLoaded();

  list.replaceChildren(...members.map((member) => {
    const ownerFlag = isProjectOwner(member.user_id);
    const displayName = displayProjectUser(member);
    const username = member.username ? `@${member.username}` : member.user_id;
    const accountRole = member.user_role === 'admin' ? 'Global Admin' : 'Member';
    const roleBadgeMap = {
      owner: { badge: 'OWNER', tone: 'owner' },
      editor: { badge: 'EDITOR', tone: 'success' },
      member: { badge: 'READ ONLY', tone: 'shared' },
    };
    const rb = roleBadgeMap[member.role] || roleBadgeMap.member;

    const row = cloneProjectMemberTemplate();
    row.dataset.userId = member.user_id;
    row.dataset.displayName = displayName;
    setMemberText(row, 'display-name', displayName);
    setMemberText(row, 'meta', `${username} · ${accountRole}`);
    const badge = row.querySelector('[data-slot="permission-badge"]');
    badge.textContent = rb.badge;
    badge.title = rb.badge;
    badge.className = `permission-badge permission-${rb.tone}`;

    const staticRole = row.querySelector('[data-slot="role-static"]');
    const roleSelect = row.querySelector('[data-slot="role-select"]');
    const removeButton = row.querySelector('[data-slot="remove-button"]');
    if (ownerFlag) {
      staticRole.textContent = 'Project Owner';
      staticRole.style.display = '';
      roleSelect.remove();
      removeButton.remove();
    } else if (canManage) {
      staticRole.remove();
      roleSelect.value = member.role || 'member';
      roleSelect.addEventListener('change', () => updateMemberRole(member.user_id, roleSelect.value));
      removeButton.addEventListener('click', () => removeProjectMember(member.user_id, encodeURIComponent(displayName)));
    } else {
      staticRole.textContent = rb.badge;
      staticRole.style.display = '';
      roleSelect.remove();
      removeButton.remove();
    }

    return row;
  }));
}

function cloneProjectMemberTemplate() {
  const template = document.getElementById('tmpl-project-member-item');
  if (!template) throw new Error('Project member template is not loaded');
  return template.content.firstElementChild.cloneNode(true);
}

function ensureProjectMemberTemplatesLoaded() {
  if (document.getElementById('tmpl-project-member-item')) {
    return Promise.resolve();
  }
  if (!projectMembersTemplatesPromise) {
    projectMembersTemplatesPromise = fetch(PROJECT_MEMBERS_TEMPLATE_URL, { headers: typeof apiHeaders === 'function' ? apiHeaders() : {} })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load project member templates');
        return res.text();
      })
      .then((html) => {
        const host = document.createElement('div');
        host.setAttribute('data-project-member-templates', '');
        host.style.display = 'none';
        host.innerHTML = html;
        document.body.appendChild(host);
      })
      .catch((err) => {
        projectMembersTemplatesPromise = null;
        throw err;
      });
  }
  return projectMembersTemplatesPromise;
}

function setMemberText(root, slotName, value) {
  const node = root.querySelector(`[data-slot="${slotName}"]`);
  if (node) node.textContent = value == null ? '' : String(value);
}

async function loadProjectMembers() {
  if (!projectData) return;
  const list = document.getElementById('project-members-list');
  if (list) list.innerHTML = renderLoading('Loading members...');

  try {
    const data = await fetchProjectJson(projectApiPath('/members'), 'Failed to load members');
    projectMembersData = Array.isArray(data.members) ? data.members : [];
    await renderProjectMembers();
  } catch (e) {
    if (list) list.innerHTML = renderError(e, 'loadProjectMembers()');
  }
}

async function openProjectMembersModal(focusShare) {
  if (!projectData) return;

  const meta = getProjectAccessMeta(projectData);
  const canManage = !!projectData.can_manage;
  document.getElementById('projectMembersModal').classList.add('active');

  const subtitle = document.getElementById('project-members-subtitle');
  if (subtitle) subtitle.textContent = `Access: ${meta.summary} · Members ${Number.isFinite(projectData.member_count) ? projectData.member_count : 0}`;

  const readonlyNote = document.getElementById('project-members-readonly-note');
  if (readonlyNote) {
    readonlyNote.style.display = canManage ? 'none' : '';
    readonlyNote.textContent = canManage ? '' : 'You are a shared member. You can view the member list, but cannot add or remove members.';
  }

  const managePanel = document.getElementById('project-members-manage-panel');
  if (managePanel) managePanel.style.display = canManage ? '' : 'none';

  await loadProjectMembers();

  if (focusShare && canManage) {
    const input = document.getElementById('project-share-username');
    if (input) input.focus();
  }
}

async function addProjectMember() {
  if (!projectData?.can_manage) { showToast('Insufficient permission to manage sharing', 'error'); return; }

  const input = document.getElementById('project-share-username');
  const roleSelect = document.getElementById('project-share-role');
  const username = input?.value?.trim();
  if (!username) {
    showToast('Please enter a username', 'error');
    return;
  }
  const role = roleSelect?.value || 'member';

  const button = document.getElementById('btn-add-member');
  await withLoading(button, async () => {
    const res = await fetch(projectApiPath('/members'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ username, role }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to add member', 'error');
      return;
    }

    if (input) input.value = '';
    showToast('Member added', 'success');
    await loadProjectShell();
    await loadProjectMembers();
  });
}

async function updateMemberRole(userId, newRole) {
  if (!requireProjectManageAccess('Insufficient permission to manage sharing')) return;
  try {
    const res = await fetch(projectApiPath(`/members/${encodeURIComponent(userId)}`), {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to update role', 'error');
      await loadProjectMembers();
      return;
    }
    const roleLabels = { member: 'Read Only', editor: 'Editor', owner: 'Owner' };
    showToast(`Role updated to ${roleLabels[newRole] || newRole}`, 'success');
    await loadProjectMembers();
  } catch (e) {
    showToast('Failed to update role', 'error');
    await loadProjectMembers();
  }
}

async function removeProjectMember(userId, encodedDisplayName) {
  if (!requireProjectManageAccess('Insufficient permission to manage sharing')) return;
  if (projectData?.owner?.id === userId) {
    showToast('Project owner cannot be removed', 'error');
    return;
  }

  const displayName = decodeURIComponent(encodedDisplayName || '');
  const confirmed = await showConfirm(`Remove ${displayName} from this project?\n\nThey will no longer see this project after removal.`, {
    title: 'Remove project member?',
    confirmLabel: 'Remove',
    tone: 'danger',
  });
  if (!confirmed) return;

  const res = await fetch(projectApiPath(`/members/${encodeURIComponent(userId)}`), { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to remove member', 'error');
    return;
  }

  showToast('Member removed', 'success');
  await loadProjectShell();
  await loadProjectMembers();
}
