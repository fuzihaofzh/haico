const LOCALHOST_SAFE_PREFIXES = [
  '/api/projects',
  '/api/issues/',
  '/api/agents/',
  '/api/command-profiles',
  '/api/generate-project',
  '/api/comments/',
  '/api/milestones',
  '/api/notifications',
  '/api/dashboard-chat',
  '/api/reactions/',
  '/api/inbox',
  '/api/knowledge/',
  '/api/my-issues',
];

const LOCALHOST_BLOCKED_PATTERNS = [
  { method: 'POST', prefix: '/api/auth/' },
  { method: 'GET', prefix: '/api/auth/' },
];

export function isLocalhostSafeRoute(method: string, url: string): boolean {
  for (const pattern of LOCALHOST_BLOCKED_PATTERNS) {
    if (method === pattern.method && url.startsWith(pattern.prefix)) {
      return false;
    }
  }
  for (const prefix of LOCALHOST_SAFE_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
  if (url.startsWith('/ws/')) return true;
  return false;
}

export function isLocalhostRequest(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
