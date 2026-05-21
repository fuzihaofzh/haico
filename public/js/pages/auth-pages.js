import { applySavedTheme } from '/public/js/shared/theme.js';

applySavedTheme();

function showAuthError(message, form) {
  const errEl = (form || document).querySelector('#error');
  if (!errEl) return;
  errEl.textContent = message;
  errEl.style.display = 'block';
}

function hideAuthError(form) {
  const errEl = (form || document).querySelector('#error');
  if (errEl) errEl.style.display = 'none';
}

function showAuthSuccess(message, form) {
  const successEl = (form || document).querySelector('#success');
  if (!successEl) return;
  successEl.textContent = message;
  successEl.style.display = 'block';
}

function hideAuthSuccess(form) {
  const successEl = (form || document).querySelector('#success');
  if (successEl) successEl.style.display = 'none';
}

function readXhrError(xhr, fallback) {
  try {
    const data = JSON.parse(xhr.responseText);
    return data.error || fallback;
  } catch (_) {
    return fallback;
  }
}

function getFormValue(form, name) {
  return form.elements[name]?.value || '';
}

function validateAuthForm(form) {
  const action = form.dataset.authAction;
  const password = getFormValue(form, 'password');
  const confirm = getFormValue(form, 'confirm');

  if (action === 'setup' || action === 'register') {
    if (password.length < 4) return 'Password must be at least 4 characters';
    if (password !== confirm) return 'Passwords do not match';
  }

  if (action === 'change-password') {
    if (password.length < 4) return 'New password must be at least 4 characters';
    if (password !== confirm) return 'Passwords do not match';
  }

  return '';
}

document.body.addEventListener('htmx:beforeRequest', (event) => {
  const form = event.detail.elt;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('auth-form')) return;

  hideAuthError(form);
  hideAuthSuccess(form);

  const validationError = validateAuthForm(form);
  if (validationError) {
    event.preventDefault();
    showAuthError(validationError, form);
  }
});

document.body.addEventListener('htmx:afterRequest', (event) => {
  const form = event.detail.elt;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('auth-form')) return;

  const action = form.dataset.authAction;
  if (event.detail.successful) {
    if (action === 'change-password') {
      form.reset();
      showAuthSuccess('Password changed successfully', form);
      return;
    }
    window.location.href = '/';
    return;
  }

  showAuthError(readXhrError(event.detail.xhr, 'Request failed'), form);
});
