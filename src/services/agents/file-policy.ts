export const MAX_AGENT_FILE_SIZE = 1024 * 1024;
export const MAX_SERVE_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_SQLITE_FILE_SIZE = 50 * 1024 * 1024;
export const SQLITE_EXTENSIONS = new Set(['.sqlite', '.db', '.sqlite3', '.db3']);

export const SERVE_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
