import {
  ANSI_RE,
  BRIDGE_NAME,
  HORDE_FETCH_INTERVAL_MS,
  RATE_WINDOW_MS,
  RECENT_JOBS_LIMIT,
  SPINNER_FRAMES,
  UI
} from './constants.js';
import { safeGet } from './http.js';
import { setConsoleLoggingEnabled } from './logger.js';

const UI_THEMES = {
  acide: {
    cyan: '\x1b[36m',
    brightWhite: '\x1b[97m',
    green: '\x1b[92m',
    yellow: '\x1b[93m',
    red: '\x1b[91m',
    orange: '\x1b[38;5;208m',
    blue: '\x1b[94m',
    gray: '\x1b[90m'
  },
  cyberpunk: {
    cyan: '\x1b[38;5;51m',
    brightWhite: '\x1b[97m',
    green: '\x1b[38;5;213m',
    yellow: '\x1b[38;5;227m',
    red: '\x1b[38;5;196m',
    orange: '\x1b[38;5;208m',
    blue: '\x1b[38;5;45m',
    gray: '\x1b[38;5;244m'
  },
  matrix: {
    cyan: '\x1b[38;5;82m',
    brightWhite: '\x1b[38;5;157m',
    green: '\x1b[38;5;46m',
    yellow: '\x1b[38;5;118m',
    red: '\x1b[38;5;196m',
    orange: '\x1b[38;5;82m',
    blue: '\x1b[38;5;22m',
    gray: '\x1b[38;5;28m'
  },
  monochrome: {
    cyan: '\x1b[37m',
    brightWhite: '\x1b[97m',
    green: '\x1b[37m',
    yellow: '\x1b[37m',
    red: '\x1b[37m',
    orange: '\x1b[37m',
    blue: '\x1b[90m',
    gray: '\x1b[90m'
  }
};

const RESIZE_SETTLE_MS = 500;

function applyUiTheme(themeName) {
  const selected = UI_THEMES[themeName] || UI_THEMES.acide;
  Object.assign(UI, selected);
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getPathValue(input, path) {
  if (!input || typeof input !== 'object') return undefined;

  const chunks = path.split('.');
  let current = input;
  for (const chunk of chunks) {
    if (current === null || current === undefined) return undefined;
    current = current[chunk];
  }
  return current;
}

function pickMetricNumber(source, candidatePaths) {
  for (const path of candidatePaths) {
    const direct = toNumberOrNull(getPathValue(source, path));
    if (direct !== null) return direct;

    const candidate = getPathValue(source, path);
    if (candidate && typeof candidate === 'object') {
      const fromText = toNumberOrNull(candidate.text);
      if (fromText !== null) return fromText;
      const fromValue = toNumberOrNull(candidate.value);
      if (fromValue !== null) return fromValue;
    }
  }
  return null;
}

function pickMetricText(source, candidatePaths) {
  for (const path of candidatePaths) {
    const value = getPathValue(source, path);
    if (value === null || value === undefined) continue;

    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
  }
  return null;
}

function formatBool(value) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'enabled'].includes(normalized)) return 'yes';
  if (['false', '0', 'no', 'disabled'].includes(normalized)) return 'no';
  return 'n/a';
}

function formatKudosDetailsRows(kudosDetails) {
  if (!kudosDetails || typeof kudosDetails !== 'object') {
    return ['Kudos Details: not provided by API'];
  }

  const detailPairs = [
    ['accumulated', 'Accumulated'],
    ['gifted', 'Gifted'],
    ['awarded', 'Awarded'],
    ['received', 'Received'],
    ['recurring', 'Recurring'],
    ['styled', 'Styled'],
    ['admin', 'Admin']
  ];

  const available = detailPairs
    .map(([key, label]) => [label, toNumberOrNull(kudosDetails[key])])
    .filter(([, value]) => value !== null);

  if (available.length === 0) {
    return ['Kudos Details: present but no numeric fields'];
  }

  const rows = [];
  for (let i = 0; i < available.length; i += 2) {
    const left = available[i];
    const right = available[i + 1];
    if (right) {
      rows.push(`Kudos Details: ${left[0]} ${formatInt(left[1])} | ${right[0]} ${formatInt(right[1])}`);
    } else {
      rows.push(`Kudos Details: ${left[0]} ${formatInt(left[1])}`);
    }
  }
  return rows;
}

function formatInt(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return number.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatFloat(value, fractionDigits = 1) {
  if (value === null || value === undefined || value === '') return 'n/a';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return number.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  });
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function formatDurationMs(ms, fallback = 'n/a') {
  if (!Number.isFinite(ms) || ms < 0) return fallback;
  if (ms >= 1000) return `${formatFloat(ms / 1000, 1)} s`;
  return `${formatInt(ms)} ms`;
}

function formatTimestamp(ts) {
  if (!ts) return 'n/a';
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

function formatLlamaSlotStage(stage) {
  const normalized = String(stage ?? '').trim().toLowerCase();
  if (normalized === 'preprompt') return 'PREPROMPT';
  if (normalized === 'processing') return 'PROCESSING';
  if (normalized === 'pending') return 'PENDING';
  if (normalized === 'idle') return 'IDLE';
  return 'UNKNOWN';
}

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_RE, '');
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function truncateAnsi(value, limit = 60) {
  const str = String(value ?? '');
  if (visibleLength(str) <= limit) return str;
  const plain = stripAnsi(str);
  return `${plain.slice(0, Math.max(0, limit - 3))}...`;
}

function padAnsiEnd(value, width) {
  const str = String(value ?? '');
  const missing = Math.max(0, width - visibleLength(str));
  return str + ' '.repeat(missing);
}

function colorizeValue(valueText) {
  const text = String(valueText ?? '');
  if (/^(n\/a|none|not provided)/i.test(text)) return `${UI.yellow}${text}${UI.reset}`;
  if (/(error|failed|faulted|rejected)/i.test(text)) return `${UI.red}${text}${UI.reset}`;
  return `${UI.green}${text}${UI.reset}`;
}

function colorizeRow(row) {
  const plainRow = String(row ?? '');
  const separatorIndex = plainRow.indexOf(':');
  if (separatorIndex <= 0) return `${UI.gray}${plainRow}${UI.reset}`;

  const label = plainRow.slice(0, separatorIndex + 1);
  const value = plainRow.slice(separatorIndex + 1).trimStart();
  return `${UI.brightWhite}${label}${UI.reset} ${colorizeValue(value)}`;
}

function buildSparkline(timeline, nowMs, buckets = 20, windowMs = RATE_WINDOW_MS) {
  const cutoff = nowMs - windowMs;
  const bucketMs = Math.max(1, Math.floor(windowMs / buckets));
  const histogram = new Array(buckets).fill(0);

  for (const ts of timeline) {
    if (ts < cutoff || ts > nowMs) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((ts - cutoff) / bucketMs)));
    histogram[idx] += 1;
  }

  const max = Math.max(1, ...histogram);
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return histogram
    .map((value) => chars[Math.max(0, Math.min(chars.length - 1, Math.round((value / max) * (chars.length - 1))))])
    .join('');
}

function buildPanel(title, rows, panelWidth) {
  const width = Math.max(36, panelWidth);
  const inner = width - 4;
  const lines = [];

  lines.push(`${UI.blue}┌${'─'.repeat(inner + 2)}┐${UI.reset}`);
  lines.push(`${UI.blue}│ ${UI.bold}${UI.cyan}${padAnsiEnd(truncateAnsi(title, inner), inner)}${UI.reset}${UI.blue} │${UI.reset}`);
  lines.push(`${UI.blue}├${'─'.repeat(inner + 2)}┤${UI.reset}`);
  for (const row of rows) {
    const padded = padAnsiEnd(truncateAnsi(colorizeRow(row), inner), inner);
    lines.push(`${UI.blue}│ ${UI.reset}${padded}${UI.blue} │${UI.reset}`);
  }
  lines.push(`${UI.blue}└${'─'.repeat(inner + 2)}┘${UI.reset}`);
  return lines;
}

function stackPanels(panelGroups) {
  const lines = [];
  for (let i = 0; i < panelGroups.length; i++) {
    if (i > 0) lines.push('');
    lines.push(...panelGroups[i]);
  }
  return lines;
}

function mergeColumns(leftLines, rightLines, leftWidth, rightWidth, gap = 2) {
  const out = [];
  const total = Math.max(leftLines.length, rightLines.length);
  const spacer = ' '.repeat(gap);

  for (let i = 0; i < total; i++) {
    const left = padAnsiEnd(leftLines[i] ?? '', leftWidth);
    const right = padAnsiEnd(rightLines[i] ?? '', rightWidth);
    out.push(`${left}${spacer}${right}`);
  }
  return out;
}

function isEnabledFlag(value, defaultValue = true) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['enabled', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['disabled', 'false', '0', 'no'].includes(normalized)) return false;
  return defaultValue;
}

function normalizeRecentJobsCount(value, fallback = RECENT_JOBS_LIMIT) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(50, numeric);
}

export class BridgeDashboard {
  constructor({ logger, options, clusterUrl, hordeHeaders }) {
    this.logger = logger;
    this.options = options;
    this.clusterUrl = clusterUrl;
    this.hordeHeaders = hordeHeaders;

    applyUiTheme(this.options.uiTheme);
    this.uiLayout = String(this.options.uiLayout ?? 'horizontal').trim().toLowerCase();
    this.uiShowBridgeStats = isEnabledFlag(this.options.uiShowBridgeStats, true);
    this.uiShowThreadActivity = isEnabledFlag(this.options.uiShowThreadActivity, true);
    this.uiShowAiHordeUser = isEnabledFlag(this.options.uiShowAiHordeUser, true);
    this.uiShowAiHordePerformance = isEnabledFlag(this.options.uiShowAiHordePerformance, true);
    this.uiShowRecentJobs = isEnabledFlag(this.options.uiShowRecentJobs, true);
    this.uiRecentJobsCount = normalizeRecentJobsCount(this.options.uiRecentJobsCount, RECENT_JOBS_LIMIT);

    this.enabled = process.stdout.isTTY;
    this.renderTimer = null;
    this.fetchTimer = null;
    this.fetchInFlight = false;
    this.resizeTimer = null;
    this.resizeInProgress = false;
    this.lastRenderedLineCount = 0;
    this.lastFrameLines = [];
    this.forceFullRedraw = true;
    this.handleResize = () => {
      if (!this.resizeInProgress && this.renderTimer) {
        clearInterval(this.renderTimer);
        this.renderTimer = null;
      }
      this.resizeInProgress = true;
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
      }
      this.resizeTimer = setTimeout(() => {
        this.resizeInProgress = false;
        this.resizeTimer = null;
        this.lastFrameLines = [];
        this.lastRenderedLineCount = 0;
        this.forceFullRedraw = true;
        this.render();
        if (!this.renderTimer) {
          this.renderTimer = setInterval(() => this.render(), 1000);
        }
      }, RESIZE_SETTLE_MS);
    };

    this.stats = {
      startedAt: Date.now(),
      jobsReceived: 0,
      jobsProcessed: 0,
      totalTokens: 0,
      totalKudos: 0,
      totalGenerationDurationMs: 0,
      csamTriggers: 0,
      receivedTimeline: [],
      processedTimeline: [],
      recentJobs: [],
      activeJobs: new Map(),
      threadStates: new Map(),
      lastJobId: null,
      lastJobKudos: null,
      lastJobTps: null,
      lastJobDurationMs: null,
      lastJobSentAt: null,
      lastRuntimeMs: null,
      lastHordeFetchAt: null,
      lastHordeFetchError: null,
      lastError: null,
      maintenanceMode: false,
      gracefulShutdownRequested: false,
      hordeUser: null,
      hordePerformance: null,
      llamaSlots: null
    };
  }

  setLastError(errorText) {
    this.stats.lastError = errorText;
  }

  requestGracefulShutdown() {
    this.stats.gracefulShutdownRequested = true;
  }

  setLlamaSlotsSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.stats.llamaSlots = {
      enabled: snapshot.enabled === true,
      endpointAvailable: snapshot.endpointAvailable === true,
      lastUpdatedAt: Number.isFinite(snapshot.lastUpdatedAt) ? snapshot.lastUpdatedAt : Date.now(),
      lastFetchError: snapshot.lastFetchError ?? null,
      totalSlots: toNumberOrNull(snapshot.totalSlots) ?? 0,
      freeSlots: toNumberOrNull(snapshot.freeSlots) ?? 0,
      prepromptSlots: toNumberOrNull(snapshot.prepromptSlots) ?? 0,
      processingSlots: toNumberOrNull(snapshot.processingSlots) ?? 0,
      pendingSlots: toNumberOrNull(snapshot.pendingSlots) ?? 0,
      ctxMin: toNumberOrNull(snapshot.ctxMin),
      ctxMax: toNumberOrNull(snapshot.ctxMax),
      slots: Array.isArray(snapshot.slots) ? snapshot.slots : []
    };
  }

  pruneTimeline(timeline, nowMs = Date.now()) {
    const cutoff = nowMs - RATE_WINDOW_MS;
    while (timeline.length > 0 && timeline[0] < cutoff) {
      timeline.shift();
    }
  }

  eventsPerMinute(timeline, nowMs = Date.now()) {
    this.pruneTimeline(timeline, nowMs);
    return timeline.length;
  }

  markJobReceived(jobId) {
    const nowMs = Date.now();
    this.stats.jobsReceived += 1;
    this.stats.receivedTimeline.push(nowMs);
    this.pruneTimeline(this.stats.receivedTimeline, nowMs);
    this.stats.activeJobs.set(jobId, { receivedAt: nowMs });
  }

  setThreadState(threadId, status, jobId = null) {
    const previous = this.stats.threadStates.get(threadId);
    if (previous && previous.status === status && previous.jobId === jobId) return;

    this.stats.threadStates.set(threadId, {
      status,
      jobId,
      sinceMs: Date.now()
    });
  }

  recordJobResult({
    jobId,
    status,
    kudos = null,
    tokens = null,
    generationDurationMs = null,
    countAsProcessed = false,
    csamScore = null,
    openaiFlagged = null
  }) {
    const nowMs = Date.now();
    const active = this.stats.activeJobs.get(jobId);
    const totalDurationMs = active ? nowMs - active.receivedAt : null;
    const tps =
      Number.isFinite(tokens) && tokens > 0 && Number.isFinite(generationDurationMs) && generationDurationMs > 0
        ? tokens / (generationDurationMs / 1000)
        : null;

    if (countAsProcessed) {
      this.stats.jobsProcessed += 1;
      this.stats.processedTimeline.push(nowMs);
      this.pruneTimeline(this.stats.processedTimeline, nowMs);

      if (Number.isFinite(tokens)) this.stats.totalTokens += tokens;
      if (Number.isFinite(kudos)) {
        this.stats.totalKudos += kudos;
        this.stats.lastJobKudos = kudos;
      } else {
        this.stats.lastJobKudos = null;
      }
      if (Number.isFinite(generationDurationMs)) {
        this.stats.totalGenerationDurationMs += generationDurationMs;
      }

      this.stats.lastJobId = jobId;
      this.stats.lastJobTps = tps;
      this.stats.lastJobDurationMs = totalDurationMs;
      this.stats.lastJobSentAt = nowMs;
    }

    this.stats.recentJobs.unshift({
      id: jobId,
      status,
      kudos: Number.isFinite(kudos) ? kudos : null,
      tokens: Number.isFinite(tokens) ? tokens : null,
      tps,
      csamScore: Number.isFinite(csamScore) ? csamScore : null,
      openaiFlagged: typeof openaiFlagged === 'boolean' ? openaiFlagged : null,
      durationMs: totalDurationMs,
      timestamp: nowMs
    });

    if (this.stats.recentJobs.length > this.uiRecentJobsCount) {
      this.stats.recentJobs.length = this.uiRecentJobsCount;
    }

    this.stats.activeJobs.delete(jobId);
  }

  render() {
    if (!this.enabled) return;
    if (this.resizeInProgress) return;

    const now = Date.now();
    const termWidth = Math.max(80, process.stdout.columns || 120);
    const twoColumns = this.uiLayout === 'horizontal' && termWidth >= 100;
    const columnGap = 2;
    const leftWidth = twoColumns ? Math.floor((termWidth - columnGap) / 2) : termWidth;
    const rightWidth = twoColumns ? (termWidth - columnGap - leftWidth) : termWidth;

    const perf = this.stats.hordePerformance || {};
    const user = this.stats.hordeUser || {};
    const llamaSlots = this.stats.llamaSlots;

    const userKudos = pickMetricNumber(user, ['kudos', 'kudos.value', 'kudos_details.accumulated']);
    const workerCountUser = pickMetricNumber(user, ['worker_count', 'workers', 'active_workers']);
    const username = pickMetricText(user, ['username', 'name', 'alias', 'user.username']);
    const userId = pickMetricText(user, ['id', 'user_id', 'uid']);
    const trusted = getPathValue(user, 'trusted');
    const moderator = getPathValue(user, 'moderator');
    const kudosDetailRows = formatKudosDetailsRows(user.kudos_details);

    const queuedRequests = toNumberOrNull(perf.queued_requests);
    const queuedTextRequests = toNumberOrNull(perf.queued_text_requests);
    const workerCount = toNumberOrNull(perf.worker_count);
    const textWorkerCount = toNumberOrNull(perf.text_worker_count);
    const threadCount = toNumberOrNull(perf.thread_count);
    const textThreadCount = toNumberOrNull(perf.text_thread_count);
    const queuedTokens = toNumberOrNull(perf.queued_tokens);
    const pastMinuteTokens = toNumberOrNull(perf.past_minute_tokens);

    const textTps = Number.isFinite(pastMinuteTokens)
      ? pastMinuteTokens / 60
      : pickMetricNumber(perf, ['text_tokens_per_second', 'tokens_per_second']);

    const jobsReceivedRate = this.eventsPerMinute(this.stats.receivedTimeline, now);
    const jobsProcessedRate = this.eventsPerMinute(this.stats.processedTimeline, now);

    const avgKudosPerJob =
      this.stats.jobsProcessed > 0 ? this.stats.totalKudos / this.stats.jobsProcessed : null;
    const avgBridgeTps =
      this.stats.totalGenerationDurationMs > 0
        ? this.stats.totalTokens / (this.stats.totalGenerationDurationMs / 1000)
        : null;
    const receivedSpark = buildSparkline(this.stats.receivedTimeline, now, 20);
    const processedSpark = buildSparkline(this.stats.processedTimeline, now, 20);

    const spinner = SPINNER_FRAMES[Math.floor(now / 250) % SPINNER_FRAMES.length];

    const lines = [];
    lines.push(`${UI.blue}${'═'.repeat(termWidth)}${UI.reset}`);
    lines.push(padAnsiEnd(`${UI.bold}${UI.cyan}${BRIDGE_NAME.toUpperCase()}${UI.reset}`, termWidth));
    lines.push(
      padAnsiEnd(
        `${UI.brightWhite}Time${UI.reset} ${UI.green}${formatTimestamp(now)}${UI.reset} ${UI.gray}|${UI.reset} ` +
          `${UI.brightWhite}Uptime${UI.reset} ${UI.green}${formatUptime(now - this.stats.startedAt)}${UI.reset} ${UI.gray}|${UI.reset} ` +
          `${UI.brightWhite}Cluster${UI.reset} ${UI.green}${this.clusterUrl}${UI.reset}`,
        termWidth
      )
    );
    if (this.stats.maintenanceMode) {
      lines.push(padAnsiEnd(`${UI.bold}${UI.orange}Maintenance Mode!${UI.reset}`, termWidth));
    }
    lines.push(`${UI.blue}${'═'.repeat(termWidth)}${UI.reset}`);
    lines.push('');

    const leftPanels = [];
    const rightPanels = [];

    if (this.uiShowBridgeStats) {
      const bridgeRows = [
        `Worker Name: ${this.options.workerName}`,
        `Model: ${this.options.model}`,
        `Threads: ${formatInt(this.options.threadsInt)} | Context: ${formatInt(this.options.ctxInt)} | Max Length: ${formatInt(this.options.maxLengthInt)}`,
        `Jobs Received: ${formatInt(this.stats.jobsReceived)}`,
        `Jobs Received (60s): ${formatInt(jobsReceivedRate)}/min`,
        `Jobs Received Trend: ${receivedSpark}`,
        `Jobs Processed: ${formatInt(this.stats.jobsProcessed)}`,
        `Jobs Processed (60s): ${formatInt(jobsProcessedRate)}/min`,
        `Jobs Processed Trend: ${processedSpark}`,
        `Total Tokens: ${formatInt(this.stats.totalTokens)}`,
        `Bridge Avg Speed: ${Number.isFinite(avgBridgeTps) ? `${formatFloat(avgBridgeTps, 1)} tok/s` : 'n/a'}`,
        `Kudos Since Worker Start: ${formatInt(this.stats.totalKudos)}`,
        `Avg Kudos/Job: ${Number.isFinite(avgKudosPerJob) ? formatFloat(avgKudosPerJob, 2) : 'n/a'}`,
        `Last Job Kudos: ${Number.isFinite(this.stats.lastJobKudos) ? formatFloat(this.stats.lastJobKudos, 2) : 'n/a'} | Last TPS: ${Number.isFinite(this.stats.lastJobTps) ? formatFloat(this.stats.lastJobTps, 1) : 'n/a'}`,
        `Last Job Duration: ${formatDurationMs(this.stats.lastJobDurationMs)}`,
        `CSAM Triggers: ${formatInt(this.stats.csamTriggers)}`,
        `Last Thread Runtime: ${formatDurationMs(this.stats.lastRuntimeMs)}`
      ];
      if (String(this.options.serverEngine ?? '').trim().toLowerCase() === 'llamacpp') {
        if (llamaSlots) {
          const endpointStatus = llamaSlots.endpointAvailable ? 'active' : 'missing (--slots)';
          const ctxRange = Number.isFinite(llamaSlots.ctxMin)
            ? (llamaSlots.ctxMin === llamaSlots.ctxMax
              ? formatInt(llamaSlots.ctxMin)
              : `${formatInt(llamaSlots.ctxMin)}..${formatInt(llamaSlots.ctxMax)}`)
            : 'n/a';
          bridgeRows.push(`llama.cpp strict mode: ${this.options.llamacppSlotsStrict === true ? 'enabled' : 'disabled'}`);
          bridgeRows.push(`llama.cpp /slots: ${endpointStatus}`);
          bridgeRows.push(
            `Slots: free ${formatInt(llamaSlots.freeSlots)} / total ${formatInt(llamaSlots.totalSlots)} | preprompt ${formatInt(llamaSlots.prepromptSlots)} | processing ${formatInt(llamaSlots.processingSlots)} | pending ${formatInt(llamaSlots.pendingSlots)}`
          );
          bridgeRows.push(`Slot Context (n_ctx): ${ctxRange}`);
        } else {
          bridgeRows.push('llama.cpp /slots: waiting first sample');
        }
      }
      leftPanels.push(buildPanel('Bridge Stats', bridgeRows, leftWidth));
    }

    if (this.uiShowThreadActivity) {
      const threadRows = [];
      for (let threadId = 0; threadId < this.options.threadsInt; threadId++) {
        const state = this.stats.threadStates.get(threadId) || { status: 'idle', jobId: null, sinceMs: null };
        const elapsed = Number.isFinite(state.sinceMs) ? formatDurationMs(now - state.sinceMs, '-') : '-';
        const jobText = state.jobId ? ` #${state.jobId}` : '';
        threadRows.push(`Thread ${threadId}: [${spinner}] ${String(state.status).toUpperCase()}${jobText} (${elapsed})`);
      }
      leftPanels.push(buildPanel('Thread Activity', threadRows, leftWidth));
    }

    if (this.uiShowAiHordeUser) {
      const userRows = [
        `Username: ${username ?? 'not provided by API'}`,
        `User ID: ${userId ?? 'not provided by API'}`,
        `Trusted: ${formatBool(trusted)} | Moderator: ${formatBool(moderator)}`,
        `Workers (account): ${workerCountUser !== null ? formatInt(workerCountUser) : 'not provided by API'}`,
        `Total Kudos: ${formatInt(userKudos)}`
      ];
      userRows.push(...kudosDetailRows);
      rightPanels.push(buildPanel('AI Horde User', userRows, rightWidth));
    }

    if (this.uiShowAiHordePerformance) {
      rightPanels.push(buildPanel('AI Horde Performance', [
        `Global Queue: ${formatInt(queuedRequests)} | Text Queue: ${formatInt(queuedTextRequests)}`,
        `Workers: ${formatInt(workerCount)} total | ${formatInt(textWorkerCount)} text`,
        `Threads: ${formatInt(threadCount)} total | ${formatInt(textThreadCount)} text`,
        `Queued Tokens: ${formatFloat(queuedTokens, 1)} | Past Minute: ${formatFloat(pastMinuteTokens, 1)}`,
        `Text Speed (network): ${Number.isFinite(textTps) ? `${formatFloat(textTps, 1)} tokens/sec` : 'n/a'}`,
        `Last Fetch: ${formatTimestamp(this.stats.lastHordeFetchAt)}`,
        `Fetch Error: ${this.stats.lastHordeFetchError ?? 'none'}`
      ], rightWidth));
    }

    if (String(this.options.serverEngine ?? '').trim().toLowerCase() === 'llamacpp' && llamaSlots) {
      const slotRows = [
        `Endpoint: ${llamaSlots.endpointAvailable ? 'active' : 'not available (launch llama-server with --slots)'}`,
        `Last Sample: ${formatTimestamp(llamaSlots.lastUpdatedAt)}`,
        `Last Error: ${llamaSlots.lastFetchError ?? 'none'}`
      ];

      for (const slot of llamaSlots.slots.slice(0, 12)) {
        const slotId = formatInt(slot.id);
        const stage = formatLlamaSlotStage(slot.stage);
        const task = Number.isFinite(toNumberOrNull(slot.idTask)) ? `task ${formatInt(slot.idTask)}` : 'task -';
        const decoded = Number.isFinite(toNumberOrNull(slot.nDecoded)) ? formatInt(slot.nDecoded) : '-';
        const remain = Number.isFinite(toNumberOrNull(slot.nRemain)) ? formatInt(slot.nRemain) : '-';
        const nCtx = Number.isFinite(toNumberOrNull(slot.nCtx)) ? formatInt(slot.nCtx) : '-';
        slotRows.push(`Slot ${slotId}: ${stage} | ${task} | decoded ${decoded} | remain ${remain} | ctx ${nCtx}`);
      }

      if (llamaSlots.slots.length > 12) {
        slotRows.push(`Additional Slots: +${formatInt(llamaSlots.slots.length - 12)} not shown`);
      }

      rightPanels.push(buildPanel('llama.cpp Slots', slotRows, rightWidth));
    }

    const recentRows = this.stats.recentJobs.map((job) => {
      if (String(job.status).startsWith('csam_')) {
        const oaFlag = typeof job.openaiFlagged === 'boolean' ? String(job.openaiFlagged) : 'n/a';
        const durationText = Number.isFinite(job.durationMs) ? formatDurationMs(job.durationMs, '-') : '-';
        return `#${job.id} ${String(job.status).toUpperCase()} | oa ${oaFlag} | ${durationText}`;
      }

      const kudosText = Number.isFinite(job.kudos) ? formatInt(Math.round(job.kudos)) : '-';
      const tokenText = Number.isFinite(job.tokens) ? formatInt(job.tokens) : '-';
      const tpsText = Number.isFinite(job.tps) ? formatFloat(job.tps, 1) : '-';
      const durationText = Number.isFinite(job.durationMs) ? formatDurationMs(job.durationMs, '-') : '-';
      const oaFlagText = typeof job.openaiFlagged === 'boolean' ? ` | oa ${String(job.openaiFlagged)}` : '';
      return `#${job.id} ${String(job.status).toUpperCase()} | kudos ${kudosText} | tok ${tokenText} | tps ${tpsText}${oaFlagText} | ${durationText}`;
    });

    const recentPanel = this.uiShowRecentJobs
      ? buildPanel('Recent Jobs', recentRows.length ? recentRows : ['No completed jobs yet.'], twoColumns ? termWidth : leftWidth)
      : null;

    if (twoColumns) {
      const leftStack = stackPanels(leftPanels);
      const rightStack = stackPanels(rightPanels);
      if (leftStack.length && rightStack.length) {
        lines.push(...mergeColumns(leftStack, rightStack, leftWidth, rightWidth, columnGap));
      } else if (leftStack.length) {
        lines.push(...leftStack);
      } else if (rightStack.length) {
        lines.push(...rightStack);
      }
    } else {
      const verticalPanels = [...leftPanels, ...rightPanels];
      if (verticalPanels.length) {
        lines.push(...stackPanels(verticalPanels));
      }
    }
    if (recentPanel) {
      lines.push('');
      lines.push(...recentPanel);
    }

    const lastErrorValue = this.stats.lastError ?? 'none';
    lines.push(
      `${UI.brightWhite}Last Error:${UI.reset} ${/none/i.test(lastErrorValue) ? `${UI.green}${lastErrorValue}${UI.reset}` : `${UI.red}${lastErrorValue}${UI.reset}`}`
    );
    lines.push('');
    if (this.stats.gracefulShutdownRequested) {
      const activeJobsCount = this.stats.activeJobs.size;
      lines.push(`${UI.yellow}Graceful shutdown requested.${UI.reset} Waiting for ${activeJobsCount} active job(s).`);
      lines.push(`${UI.dim}${UI.brightWhite}Press Ctrl+C again to force immediate stop.${UI.reset}`);
    } else {
      lines.push(`${UI.dim}${UI.brightWhite}Press Ctrl+C to exit.${UI.reset}`);
    }

    const frameLines = lines.map((line) => `\x1b[2K${line}`);
    const extraOldLines = Math.max(0, this.lastRenderedLineCount - frameLines.length);
    for (let i = 0; i < extraOldLines; i++) {
      frameLines.push('\x1b[2K');
    }
    const writes = [];
    if (this.forceFullRedraw) {
      writes.push('\x1b[2J\x1b[H');
      this.forceFullRedraw = false;
    }
    const total = Math.max(this.lastFrameLines.length, frameLines.length);

    for (let i = 0; i < total; i++) {
      const nextLine = frameLines[i] ?? '\x1b[2K';
      const prevLine = this.lastFrameLines[i];
      if (nextLine === prevLine) continue;
      writes.push(`\x1b[${i + 1};1H${nextLine}`);
    }

    writes.push(`\x1b[${frameLines.length + 1};1H`);

    this.lastFrameLines = frameLines;
    this.lastRenderedLineCount = frameLines.length;
    if (writes.length > 0) {
      process.stdout.write(writes.join(''));
    }
  }

  async refreshHordeData() {
    if (this.fetchInFlight) return;
    this.fetchInFlight = true;

    try {
      const [userResp, perfResp] = await Promise.all([
        safeGet({ url: `${this.clusterUrl}/api/v2/find_user`, headers: this.hordeHeaders, timeoutMs: 15000, logger: this.logger }),
        safeGet({ url: `${this.clusterUrl}/api/v2/status/performance`, timeoutMs: 15000, logger: this.logger })
      ]);

      const fetchErrors = [];
      if (userResp.ok) this.stats.hordeUser = userResp.data;
      else fetchErrors.push(`find_user failed (${userResp.status ?? 'network'})`);

      if (perfResp.ok) this.stats.hordePerformance = perfResp.data;
      else fetchErrors.push(`status/performance failed (${perfResp.status ?? 'network'})`);

      this.stats.lastHordeFetchError = fetchErrors.length ? fetchErrors.join(' | ') : null;
    } catch (error) {
      this.stats.lastHordeFetchError = `dashboard refresh failed: ${error.message}`;
      this.setLastError(this.stats.lastHordeFetchError);
    } finally {
      this.stats.lastHordeFetchAt = Date.now();
      this.fetchInFlight = false;
      this.render();
    }
  }

  start() {
    if (!this.enabled) return;

    setConsoleLoggingEnabled(this.logger, false);
    process.stdout.write('\x1b[?25l');
    process.stdout.on('resize', this.handleResize);
    this.render();
    this.renderTimer = setInterval(() => this.render(), 1000);
    this.fetchTimer = setInterval(() => {
      this.refreshHordeData().catch((error) => {
        this.setLastError(`dashboard polling exception: ${error.message}`);
      });
    }, HORDE_FETCH_INTERVAL_MS);

    this.refreshHordeData().catch((error) => {
      this.setLastError(`initial dashboard fetch failed: ${error.message}`);
    });
  }

  stop() {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.resizeInProgress = false;
    process.stdout.off('resize', this.handleResize);
    this.lastRenderedLineCount = 0;
    this.lastFrameLines = [];
    this.forceFullRedraw = true;

    if (this.enabled) {
      process.stdout.write('\x1b[?25h');
      setConsoleLoggingEnabled(this.logger, true);
    }
  }
}
