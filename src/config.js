import fs from 'fs';
import { RECENT_JOBS_LIMIT } from './constants.js';

const CONFIG_FILE = 'config.yaml';
const ALLOWED_UI_THEMES = ['acide', 'cyberpunk', 'matrix', 'monochrome'];
const ALLOWED_UI_LAYOUTS = ['vertical', 'horizontal'];
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
    threadPollStagger: 'enabled',
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
    UI: {
      layout: 'horizontal',
      showBridgeStats: 'enabled',
      showThreadActivity: 'enabled',
      showAiHordeUser: 'enabled',
      showAiHordePerformance: 'enabled',
      showRecentJobs: 'enabled',
      recentJobsCount: RECENT_JOBS_LIMIT
    },
    threads: 1,
    timeout: 120
  };

  const options = { ...defaults, ...loaded };
  const uiSection = normalizeUiSection(options.UI, loaded.ui);
  options.enableCsamFilter = parseCsamMode(options.enableCsamFilter);
  options.csamPositiveAction = parseCsamPositiveAction(options.csamPositiveAction);
  options.nsfw = parseBoolean(options.nsfw, 'nsfw');
  options.enforceCtxLimit = parseBoolean(options.enforceCtxLimit, 'enforceCtxLimit');
  options.threadPollStagger = parseBoolean(options.threadPollStagger, 'threadPollStagger');
  options.uiLayout = parseUiLayout(uiSection.layout);
  options.uiShowBridgeStats = parseBoolean(uiSection.showBridgeStats, 'UI.showBridgeStats');
  options.uiShowThreadActivity = parseBoolean(uiSection.showThreadActivity, 'UI.showThreadActivity');
  options.uiShowAiHordeUser = parseBoolean(uiSection.showAiHordeUser, 'UI.showAiHordeUser');
  options.uiShowAiHordePerformance = parseBoolean(uiSection.showAiHordePerformance, 'UI.showAiHordePerformance');
  options.uiShowRecentJobs = parseBoolean(uiSection.showRecentJobs, 'UI.showRecentJobs');
  options.uiRecentJobsCount = parsePositiveIntInRange(
    uiSection.recentJobsCount,
    'UI.recentJobsCount',
    1,
    50,
    RECENT_JOBS_LIMIT
  );
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
  const serverEngine = String(options.serverEngine).trim().toLowerCase();
  if (['ollama', 'oobabooga', 'textgenwebui', 'oogabooga', 'lmstudio', 'localai', 'mistralrs', 'mistral.rs', 'mlx', 'openllm', 'aphrodite', 'aphrodite-engine'].includes(serverEngine) && !options.serverModel) {
    throw new Error('"serverModel" is required in config.yaml when serverEngine is ollama/oobabooga/lmstudio/localai/mistralrs/mlx/openllm/aphrodite.');
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

function normalizeUiSection(primaryValue, secondaryValue) {
  const base = {
    layout: 'horizontal',
    showBridgeStats: 'enabled',
    showThreadActivity: 'enabled',
    showAiHordeUser: 'enabled',
    showAiHordePerformance: 'enabled',
    showRecentJobs: 'enabled',
    recentJobsCount: RECENT_JOBS_LIMIT
  };

  const primary = toPlainObject(primaryValue);
  const secondary = toPlainObject(secondaryValue);
  return { ...base, ...primary, ...secondary };
}

function toPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseUiLayout(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'horizontal';
  if (!ALLOWED_UI_LAYOUTS.includes(normalized)) {
    throw new Error(`Invalid UI.layout value "${value}". Use vertical/horizontal.`);
  }
  return normalized;
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
  const lines = rawText.split(/\r?\n/);

  function getLineInfo(lineNumber) {
    if (lineNumber < 0 || lineNumber >= lines.length) return null;
    const noComment = stripHashComment(lines[lineNumber]);
    if (!noComment.trim()) return null;

    const indentMatch = /^(\s*)/.exec(noComment);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const trimmed = noComment.trim();
    return { lineNumber, indent, trimmed };
  }

  function nextSignificant(startLine) {
    for (let i = startLine; i < lines.length; i++) {
      const info = getLineInfo(i);
      if (info) return info;
    }
    return null;
  }

  function parseList(expectedIndent, startLine) {
    const out = [];
    let lineNumber = startLine;

    while (lineNumber < lines.length) {
      const info = getLineInfo(lineNumber);
      if (!info) {
        lineNumber += 1;
        continue;
      }
      if (info.indent < expectedIndent) break;
      if (info.indent > expectedIndent) {
        throw new Error(`Unsupported indentation at line ${info.lineNumber + 1}`);
      }
      if (!info.trimmed.startsWith('- ')) {
        throw new Error(`Invalid list item at line ${info.lineNumber + 1}`);
      }

      const valueRaw = info.trimmed.slice(2);
      if (!valueRaw.trim()) {
        throw new Error(`Empty list item is not supported at line ${info.lineNumber + 1}`);
      }
      out.push(parseScalar(valueRaw));
      lineNumber += 1;
    }

    return { value: out, nextLine: lineNumber };
  }

  function parseMap(expectedIndent, startLine) {
    const out = {};
    let lineNumber = startLine;

    while (lineNumber < lines.length) {
      const info = getLineInfo(lineNumber);
      if (!info) {
        lineNumber += 1;
        continue;
      }
      if (info.indent < expectedIndent) break;
      if (info.indent > expectedIndent) {
        throw new Error(`Unsupported indentation at line ${info.lineNumber + 1}`);
      }
      if (info.trimmed.startsWith('- ')) {
        throw new Error(`Unexpected list item at line ${info.lineNumber + 1}`);
      }

      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(info.trimmed);
      if (!match) {
        throw new Error(`Invalid key/value at line ${info.lineNumber + 1}`);
      }

      const key = match[1];
      const rawValue = match[2];

      if (rawValue.trim() !== '') {
        out[key] = parseScalar(rawValue);
        lineNumber += 1;
        continue;
      }

      const child = nextSignificant(info.lineNumber + 1);
      if (!child || child.indent <= expectedIndent) {
        out[key] = [];
        lineNumber += 1;
        continue;
      }
      if (child.indent !== expectedIndent + 2) {
        throw new Error(`Unsupported indentation at line ${child.lineNumber + 1}`);
      }

      if (child.trimmed.startsWith('- ')) {
        const parsed = parseList(expectedIndent + 2, child.lineNumber);
        out[key] = parsed.value;
        lineNumber = parsed.nextLine;
      } else {
        const parsed = parseMap(expectedIndent + 2, child.lineNumber);
        out[key] = parsed.value;
        lineNumber = parsed.nextLine;
      }
    }

    return { value: out, nextLine: lineNumber };
  }

  return parseMap(0, 0).value;
}
