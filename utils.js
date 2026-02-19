import { createLogger, setConsoleLoggingEnabled } from './src/logger.js';
import { safeGet, safePost } from './src/http.js';

export const defaultLogger = createLogger('');

export function safePostCompat(url, body, headers = {}, timeout = 30000, logger = defaultLogger) {
  return safePost({ url, body, headers, timeoutMs: timeout, logger });
}

export function safeGetCompat(url, headers = {}, timeout = 30000, logger = defaultLogger) {
  return safeGet({ url, headers, timeoutMs: timeout, logger });
}

// Backward-compatible named exports.
export { setConsoleLoggingEnabled };
export { safePostCompat as safePost, safeGetCompat as safeGet };
