// Global htmx event listeners for admin pages.
// Listens for htmx-dispatched events (from HX-Trigger response headers) and
// renders transient toasts. Fragment swap targets are handled declaratively
// by htmx attributes in the markup; this only covers out-of-band signals.

function ensureToastContainer() {
  let container = document.getElementById('admin-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'admin-toast-container';
    container.className = 'admin-toast-container';
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = 'admin-toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('admin-toast-show'));
  setTimeout(() => {
    toast.classList.remove('admin-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// htmx dispatches a custom event for each key in an HX-Trigger JSON header.
// Server sends `HX-Trigger: {"showToast":"<message>"}`.
document.body.addEventListener('showToast', (evt) => {
  const detail = evt.detail;
  const message = detail?.value ?? detail ?? '';
  if (message) showToast(String(message));
});
