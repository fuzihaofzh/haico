let _notifAudioCtx = null;
let _notifLastPlayTime = 0;

function getAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!_notifAudioCtx) {
    _notifAudioCtx = new AudioContextCtor();
  }
  return _notifAudioCtx;
}

function unlockAudioCtx() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume();
  }
}

function playDingSound(ctx) {
  const t = ctx.currentTime;
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain = ctx.createGain();

  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(880, t);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(1175, t + 0.1);

  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(ctx.destination);

  osc1.start(t);
  osc1.stop(t + 0.15);
  osc2.start(t + 0.1);
  osc2.stop(t + 0.4);
}

export function playNotificationSound() {
  if (!isNotificationSoundEnabled()) return;

  const now = Date.now();
  if (now - _notifLastPlayTime < 5000) return;
  _notifLastPlayTime = now;

  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().then(function() {
      if (ctx.state === 'running') {
        playDingSound(ctx);
      }
    });
  } else if (ctx.state === 'running') {
    playDingSound(ctx);
  }
}

export function isNotificationSoundEnabled() {
  return localStorage.getItem('haico-notification-sound') !== 'off';
}

export function setNotificationSoundEnabled(enabled) {
  localStorage.setItem('haico-notification-sound', enabled ? 'on' : 'off');
  syncNotificationSoundToggles();
}

export function toggleNotificationSound() {
  const nextEnabled = !isNotificationSoundEnabled();
  setNotificationSoundEnabled(nextEnabled);
  if (nextEnabled) unlockAudioCtx();
}

export function syncNotificationSoundToggles() {
  const isOn = isNotificationSoundEnabled();
  document.querySelectorAll('.notif-sound-toggle').forEach(function(el) {
    el.classList.toggle('on', isOn);
    el.classList.toggle('muted', !isOn);
    el.setAttribute('aria-pressed', String(!isOn));
    el.setAttribute('aria-label', isOn ? 'Mute notification sound' : 'Unmute notification sound');
    el.title = isOn ? 'Mute notification sound' : 'Unmute notification sound';
  });
}

export function createNotificationSoundToggle() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'notif-sound-toggle topbar-sound-toggle';
  btn.innerHTML = `
    <span class="sound-toggle-track" aria-hidden="true">
      <svg class="sound-icon sound-icon-on" viewBox="0 0 24 24">
        <path d="M4 9v6h4l5 4V5L8 9H4z"></path>
        <path d="M16 8.5a5 5 0 0 1 0 7"></path>
        <path d="M18.5 6a8 8 0 0 1 0 12"></path>
      </svg>
      <svg class="sound-icon sound-icon-off" viewBox="0 0 24 24">
        <path d="M4 9v6h4l5 4V5L8 9H4z"></path>
        <path d="M17 9l4 4"></path>
        <path d="M21 9l-4 4"></path>
      </svg>
      <span class="sound-toggle-knob"></span>
    </span>
  `;
  btn.addEventListener('click', toggleNotificationSound);
  return btn;
}

export function initNotificationSoundControls() {
  ['click', 'keydown', 'touchstart', 'mousedown'].forEach(function(evt) {
    document.addEventListener(evt, unlockAudioCtx, { once: false, passive: true });
  });
  syncNotificationSoundToggles();
}

if (typeof window !== 'undefined') {
  window.playNotificationSound = playNotificationSound;
  window.isNotificationSoundEnabled = isNotificationSoundEnabled;
  window.setNotificationSoundEnabled = setNotificationSoundEnabled;
  window.toggleNotificationSound = toggleNotificationSound;
  window.syncNotificationSoundToggles = syncNotificationSoundToggles;
  window.createNotificationSoundToggle = createNotificationSoundToggle;
  window.HAICONotificationSound = {
    playNotificationSound,
    isNotificationSoundEnabled,
    setNotificationSoundEnabled,
    toggleNotificationSound,
    syncNotificationSoundToggles,
    createNotificationSoundToggle,
    initNotificationSoundControls,
  };
}

initNotificationSoundControls();
