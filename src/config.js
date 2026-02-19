import fs from 'fs';

const CONFIG_FILE = 'config.yaml';
const ALLOWED_UI_THEMES = ['acide', 'cyberpunk', 'matrix', 'monochrome'];
const ALLOWED_CSAM_MODES = ['disabled', 'regex', 'openai'];
const ALLOWED_CSAM_POSITIVE_ACTIONS = ['respond', 'fault'];
const OPENAI_MODERATION_HARD_MAX_INPUT_TOKENS = 30000;

function parseBoolean(value, optionName) {
  if (typeof value === 'boolean') return value;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'enabled') return true;
  if (normalized === 'disabled') return false;
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;

  throw new Error(`Invalid ${optionName} value "${value}". Use enabled/disabled.`);
}

function parseCsamMode(value) {
  if (typeof value === 'boolean') {
    return value ? 'regex' : 'disabled';
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'enabled') return 'regex';
  if (normalized === 'disabled') return 'disabled';
  if (normalized === 'true' || normalized === '1') return 'regex';
  if (normalized === 'false' || normalized === '0') return 'disabled';
  if (ALLOWED_CSAM_MODES.includes(normalized)) return normalized;

  throw new Error(`Invalid enableCsamFilter value "${value}". Use disabled/regex/openai.`);
}

function parseCsamPositiveAction(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'respond';
  if (!ALLOWED_CSAM_POSITIVE_ACTIONS.includes(normalized)) {
    throw new Error(`Invalid csamPositiveAction value "${value}". Use respond/fault.`);
  }
  return normalized;
}

function parsePositiveIntInRange(value, keyName, minValue, maxValue, defaultValue) {
  if (value === null || value === undefined || String(value).trim() === '') return defaultValue;
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric) || numeric < minValue || numeric > maxValue) {
    throw new Error(`Invalid ${keyName} value "${value}". Use an integer between ${minValue} and ${maxValue}.`);
  }
  return numeric;
}

export function parseConfig() {
  let rawText;
  try {
    rawText = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read ${CONFIG_FILE}. Create it from the template and run "node index.js".`
    );
  }

  let loaded;
  try {
    loaded = parseSimpleYaml(rawText);
  } catch (error) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${error.message}`);
  }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error(`Invalid ${CONFIG_FILE}: root must be a YAML mapping/object.`);
  }

  const defaults = {
    clusterUrl: 'https://stablehorde.net',
    workerName: 'Worker',
    AiHordeApiKey: '',
    priorityUsernames: [],
    workerId: '',
    workerInfo: '',
    serverUrl: 'http://localhost:8000',
    serverEngine: null,
    serverModel: '',
    serverApiKey: '',
    model: null,
    ctx: null,
    maxLength: 512,
    enforceCtxLimit: 'disabled',
    maxTps: '',
    refreshTime: 5000,
    nsfw: 'disabled',
    enableCsamFilter: 'regex',
    csamPositiveAction: 'respond',
    csamBlockedResponse: 'Your request has been filtered by this worker safety policy.',
    csamMetadataRef: 'omni-moderation-latest sexual/minors',
    openaiModerationMaxTokens: 10000,
    openaiApiKey: '',
    outputPrompt: '',
    logFile: '',
    uiTheme: 'acide',
    threads: 1,
    timeout: 120
  };

  const options = { ...defaults, ...loaded };
  options.enableCsamFilter = parseCsamMode(options.enableCsamFilter);
  options.csamPositiveAction = parseCsamPositiveAction(options.csamPositiveAction);
  options.nsfw = parseBoolean(options.nsfw, 'nsfw');
  options.enforceCtxLimit = parseBoolean(options.enforceCtxLimit, 'enforceCtxLimit');
  options.serverApiKey = normalizeOptionalString(options.serverApiKey);
  options.serverModel = normalizeOptionalString(options.serverModel);
  options.openaiApiKey = normalizeOptionalString(options.openaiApiKey);
  options.AiHordeApiKey = normalizeOptionalString(options.AiHordeApiKey);
  options.csamBlockedResponse = normalizeOptionalString(options.csamBlockedResponse);
  options.csamMetadataRef = normalizeOptionalString(options.csamMetadataRef);
  options.openaiModerationMaxTokens = parsePositiveIntInRange(
    options.openaiModerationMaxTokens,
    'openaiModerationMaxTokens',
    1,
    OPENAI_MODERATION_HARD_MAX_INPUT_TOKENS,
    10000
  );
  options.priorityUsernames = normalizePriorityUsernames(options.priorityUsernames);
  options.workerId = normalizeOptionalString(options.workerId);
  options.workerInfo = normalizeOptionalString(options.workerInfo);
  options.uiTheme = normalizeUiTheme(options.uiTheme);

  if (!options.model) throw new Error('"model" is required in config.yaml');
  if (!options.ctx) throw new Error('"ctx" is required in config.yaml');
  if (!options.serverEngine) throw new Error('"serverEngine" is required in config.yaml');
  if (String(options.serverEngine).trim().toLowerCase() === 'ollama' && !options.serverModel) {
    throw new Error('"serverModel" is required in config.yaml when serverEngine is set to "ollama".');
  }
  if (!options.AiHordeApiKey || options.AiHordeApiKey === '0000000000') {
    throw new Error('"AiHordeApiKey" is required in config.yaml and cannot be the default placeholder value.');
  }
  if (options.enableCsamFilter === 'openai' && !options.openaiApiKey) {
    throw new Error('"openaiApiKey" is required when enableCsamFilter is set to "openai".');
  }

  const maxTpsLimit = normalizeOptionalNumber(options.maxTps);
  if (maxTpsLimit !== null && (!Number.isFinite(maxTpsLimit) || maxTpsLimit <= 0)) {
    throw new Error('"maxTps" must be a positive number in config.yaml');
  }

  return {
    ...options,
    maxTpsLimit,
    threadsInt: Number.parseInt(String(options.threads), 10),
    ctxInt: Number.parseInt(String(options.ctx), 10),
    maxLengthInt: Number.parseInt(String(options.maxLength), 10),
    timeoutMs: 1000 * Number.parseInt(String(options.timeout), 10)
  };
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function normalizePriorityUsernames(value) {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry) => entry.length > 0);
  }

  const single = normalizeOptionalString(value);
  if (single.length === 0) return [];
  return [single];
}

function normalizeUiTheme(value) {
  const theme = normalizeOptionalString(value).toLowerCase();
  if (theme.length === 0) return 'acide';
  if (!ALLOWED_UI_THEMES.includes(theme)) {
    throw new Error(
      `"uiTheme" must be one of: ${ALLOWED_UI_THEMES.join(', ')}`
    );
  }
  return theme;
}

function stripHashComment(line) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function splitTopLevelCommas(input) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;

    if (char === ',' && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length) parts.push(current.trim());
  return parts;
}

function parseScalar(valueRaw) {
  const value = valueRaw.trim();
  if (value === '') return '';

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const lower = value.toLowerCase();
  if (lower === 'null' || lower === '~') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevelCommas(inner).map(parseScalar);
  }

  return value;
}

function parseSimpleYaml(rawText) {
  const result = {};
  let currentListKey = null;

  const lines = rawText.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const originalLine = lines[lineNumber];
    const noComment = stripHashComment(originalLine);
    if (!noComment.trim()) continue;

    const isIndented = /^\s+/.test(noComment);
    const trimmed = noComment.trim();

    if (isIndented) {
      if (currentListKey && trimmed.startsWith('- ')) {
        result[currentListKey].push(parseScalar(trimmed.slice(2)));
        continue;
      }
      throw new Error(`Unsupported indentation at line ${lineNumber + 1}`);
    }

    currentListKey = null;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid key/value at line ${lineNumber + 1}`);
    }

    const key = match[1];
    const rawValue = match[2];
    if (rawValue.trim() === '') {
      result[key] = [];
      currentListKey = key;
      continue;
    }

    result[key] = parseScalar(rawValue);
  }

  return result;
}
