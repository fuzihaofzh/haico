export function getCachedJson(key, ttlMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== 'object') return null;
    if (ttlMs && Date.now() - Number(entry.storedAt || 0) > ttlMs) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.value ?? null;
  } catch (_) {
    return null;
  }
}

export function setCachedJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ storedAt: Date.now(), value }));
  } catch (_) {}
}

export function removeCached(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}
