window.addEventListener('haico:project-ready', () => {
  openProjectMembersPage(false);
});

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('project-share-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    addProjectMember();
  });
});

loadProjectShell();
