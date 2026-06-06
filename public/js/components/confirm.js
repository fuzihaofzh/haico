function renderConfirmModal(opts, messageHtml) {
  const tone = opts.tone;
  return h`<div class="modal confirm-modal confirm-modal-${tone}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="confirm-modal-header">
        <div class="confirm-modal-eyebrow">${tone === 'danger' ? 'Danger zone' : 'Confirmation'}</div>
        <h3 id="confirm-title" class="confirm-modal-title">${opts.title}</h3>
      </div>
      <div class="confirm-modal-body">
        <div class="confirm-modal-message">${html(messageHtml)}</div>
      </div>
      <div class="modal-actions confirm-modal-actions">
        <button class="btn btn-sm" id="confirm-cancel" type="button">${opts.cancelLabel}</button>
        <button class="btn btn-sm ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}" id="confirm-ok" type="button">${opts.confirmLabel}</button>
      </div>
    </div>`;
}

export function showConfirm(message, options) {
  const input = options || {};
  const tone = input.tone === 'danger' ? 'danger' : 'default';
  const opts = {
    tone,
    title: input.title || (tone === 'danger' ? 'Confirm deletion' : 'Confirm action'),
    confirmLabel: input.confirmLabel || (tone === 'danger' ? 'Delete' : 'Confirm'),
    cancelLabel: input.cancelLabel || 'Cancel',
  };
  const messageHtml = String(message || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\n/g,'<br>');

  return new Promise((resolve) => {
    let overlay = document.getElementById('confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-overlay';
      overlay.className = 'modal-overlay confirm-overlay';
      document.body.appendChild(overlay);
    }

    const close = (value) => {
      overlay.classList.remove('active');
      overlay.innerHTML = '';
      overlay.removeEventListener('click', handleOverlayClick);
      document.removeEventListener('keydown', handleKeydown, true);
      resolve(value);
    };

    const handleOverlayClick = (event) => {
      if (event.target === overlay) close(false);
    };

    const handleKeydown = (event) => {
      if (!overlay.classList.contains('active')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const active = document.activeElement;
        const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
        if (tag === 'textarea') return;
        const confirmButton = document.getElementById('confirm-ok');
        if (confirmButton) {
          event.preventDefault();
          confirmButton.click();
        }
      }
    };

    overlay.innerHTML = renderConfirmModal(opts, messageHtml);
    overlay.classList.add('active');
    overlay.addEventListener('click', handleOverlayClick);
    document.addEventListener('keydown', handleKeydown, true);

    const confirmButton = document.getElementById('confirm-ok');
    const cancelButton = document.getElementById('confirm-cancel');
    if (confirmButton) confirmButton.onclick = () => close(true);
    if (cancelButton) cancelButton.onclick = () => close(false);

    requestAnimationFrame(() => {
      if (tone === 'danger' && cancelButton) cancelButton.focus();
      else if (confirmButton) confirmButton.focus();
    });
  });
}

if (typeof window !== 'undefined') {
  window.showConfirm = showConfirm;
}
