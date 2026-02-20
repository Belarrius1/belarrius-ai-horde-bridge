export const BRIDGE_NAME = 'Belarrius AI Horde Bridge v1.2';
export const BRIDGE_REPO = 'https://github.com/Belarrius1/belarrius-ai-horde-bridge';
export const BRIDGE_AGENT = `Belarrius AI Horde Bridge:1.2:${BRIDGE_REPO}`;

export const HORDE_API_BASE = 'https://aihorde.net/api/v2';
export const HORDE_FETCH_INTERVAL_MS = 30000;

export const RATE_WINDOW_MS = 60000;
export const RECENT_JOBS_LIMIT = 7;

export const MAX_POP_RETRIES = 3;
export const MAX_GENERATION_RETRIES = 3;
export const MAX_SUBMIT_RETRIES = 5;
export const MAX_FAILED_REQUESTS = 6;

export const SPINNER_FRAMES = ['|', '/', '-', '\\'];
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const UI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  brightWhite: '\x1b[97m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
  orange: '\x1b[38;5;208m',
  blue: '\x1b[94m',
  gray: '\x1b[90m'
};
