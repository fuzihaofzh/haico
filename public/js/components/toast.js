function getToastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function hideToast(toast) {
  if (toast && typeof toast.remove === 'function') {
    toast.remove();
  }
}

export function showToast(message, type) {
  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + (type || 'info');
  toast.textContent = message;
  toast.onclick = function() {
    hideToast(toast);
  };
  container.appendChild(toast);
  setTimeout(function() {
    hideToast(toast);
  }, 3000);
  return toast;
}

if (typeof window !== 'undefined') {
  window.showToast = showToast;
  window.hideToast = hideToast;
}
