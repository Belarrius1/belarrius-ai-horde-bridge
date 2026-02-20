import axios from 'axios';
import {
  BRIDGE_AGENT,
  MAX_GENERATION_RETRIES,
  MAX_POP_RETRIES,
  MAX_SUBMIT_RETRIES
} from './constants.js';
import { safePost } from './http.js';
import { isCsamPrompt } from './csam.js';
import { logCsamTriggerForAudit, logPromptForAudit, sleep } from './runtime-utils.js';

function ensureStringArray(input) {
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item ?? '').trim())
      .filter((item) => item.length > 0);
  }

  const single = String(input ?? '').trim();
  if (!single) return [];
  return [single];
}

function getOpenAiMinorScore(result) {
  const scores = result?.category_scores ?? {};
  const score =
    scores['sexual/minors'] ??
    scores.sexual_minors ??
    scores['sexual-minors'];
  return Number.isFinite(Number(score)) ? Number(score) : null;
}

function getOpenAiCsamBoolean(result) {
  const categories = result?.categories ?? {};
  const minors =
    categories['sexual/minors'] === true ||
    categories.sexual_minors === true ||
    categories['sexual-minors'] === true;
  return minors;
}

export class BridgeWorker {
  constructor({
    threadId,
    logger,
    options,
    engine,
    dashboard,
    runtime,
    clusterUrl,
    hordeHeaders,
    serverHeaders
  }) {
    this.threadId = threadId;
    this.logger = logger;
    this.options = options;
    this.engine = engine;
    this.dashboard = dashboard;
    this.runtime = runtime;
    this.clusterUrl = clusterUrl;
    this.hordeHeaders = hordeHeaders;
    this.serverHeaders = serverHeaders;

    this.serverStatusCache = { lastRetrieved: null, lastStatus: null };
    this.nextAllowedAtMs = Date.now();
    this.throttleQueue = Promise.resolve();
  }

  async countGenerationTokens(generation, maxLengthHint) {
    if (typeof generation !== 'string' || generation.length === 0) return 0;

    if (this.engine.tokenize) {
      const tokens = await this.engine.tokenize(generation, this.options.serverUrl, this.serverHeaders);
      if (tokens) return tokens.length;
    }

    const wordEstimate = generation.trim().split(/\s+/).filter(Boolean).length;
    const charEstimate = Math.ceil(generation.length / 3);
    let approxTokens = Math.max(1, wordEstimate, charEstimate);
    if (Number.isFinite(maxLengthHint) && maxLengthHint > 0) {
      approxTokens = Math.min(approxTokens, maxLengthHint);
    }
    return approxTokens;
  }

  async countPromptTokens(prompt) {
    if (typeof prompt !== 'string' || prompt.length === 0) return 0;

    if (this.engine.tokenize) {
      const tokens = await this.engine.tokenize(prompt, this.options.serverUrl, this.serverHeaders);
      if (tokens) return tokens.length;
    }

    const wordEstimate = prompt.trim().split(/\s+/).filter(Boolean).length;
    const charEstimate = Math.ceil(prompt.length / 3);
    return Math.max(1, wordEstimate, charEstimate);
  }

  async buildOpenAiModerationInput(prompt) {
    const maxTokens = this.options.openaiModerationMaxTokens;
    const estimatedTokens = await this.countPromptTokens(prompt);

    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= maxTokens) {
      return {
        text: prompt,
        truncated: false,
        estimatedTokens,
        originalEstimatedTokens: estimatedTokens
      };
    }

    // Best effort: exact token truncation when engine exposes tokenize+detokenize.
    if (this.engine.tokenize && this.engine.detokenize) {
      try {
        const tokens = await this.engine.tokenize(prompt, this.options.serverUrl, this.serverHeaders);
        if (Array.isArray(tokens) && tokens.length > maxTokens) {
          const sliced = tokens.slice(0, maxTokens);
          const rebuilt = await this.engine.detokenize(sliced, this.options.serverUrl, this.serverHeaders);
          if (typeof rebuilt === 'string' && rebuilt.length > 0) {
            return {
              text: rebuilt,
              truncated: true,
              estimatedTokens: maxTokens,
              originalEstimatedTokens: tokens.length
            };
          }
        }
      } catch {
        // Fallback below.
      }
    }

    // Conservative fallback when we cannot detokenize: keep prompt head proportionally.
    const ratio = Math.max(0.05, Math.min(1, maxTokens / estimatedTokens));
    const keepChars = Math.max(200, Math.floor(prompt.length * ratio));
    return {
      text: prompt.slice(0, keepChars),
      truncated: true,
      estimatedTokens: maxTokens,
      originalEstimatedTokens: estimatedTokens
    };
  }

  async moderatePromptWithOpenAI(prompt) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/moderations',
        {
          model: 'omni-moderation-latest',
          input: prompt
        },
        {
          headers: {
            Authorization: `Bearer ${this.options.openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const result = response.data?.results?.[0];
      if (!result || typeof result !== 'object') {
        return { ok: false, blocked: false, error: 'OpenAI moderation response missing results[0]' };
      }

      return {
        ok: true,
        blocked: getOpenAiCsamBoolean(result),
        openaiFlagged: getOpenAiCsamBoolean(result),
        openaiMinorScore: getOpenAiMinorScore(result)
      };
    } catch (error) {
      const status = error.response?.status;
      const message = status ? `OpenAI moderation HTTP ${status}` : `OpenAI moderation error: ${error.message}`;
      return { ok: false, blocked: false, error: message };
    }
  }

  async evaluateCsam(prompt) {
    const mode = this.options.enableCsamFilter;
    if (mode === 'disabled') {
      return { blocked: false, reason: null, mode, openaiMinorScore: null };
    }

    if (isCsamPrompt(prompt)) {
      return { blocked: true, reason: 'csam_regex', mode: 'regex', openaiMinorScore: null };
    }

    if (mode === 'openai') {
      const moderationInput = await this.buildOpenAiModerationInput(prompt);
      const moderation = await this.moderatePromptWithOpenAI(moderationInput.text);
      if (!moderation.ok) {
        this.dashboard.setLastError(moderation.error);
        return { blocked: true, reason: 'csam_openai_unavailable', mode: 'openai', openaiMinorScore: null };
      }
      if (moderation.blocked) {
        return {
          blocked: true,
          reason: 'csam_openai',
          mode: 'openai',
          openaiFlagged: moderation.openaiFlagged,
          openaiMinorScore: moderation.openaiMinorScore
        };
      }
      return {
        blocked: false,
        reason: null,
        mode: 'openai',
        openaiFlagged: moderation.openaiFlagged,
        openaiMinorScore: moderation.openaiMinorScore
      };
    }

    return { blocked: false, reason: null, mode, openaiFlagged: null, openaiMinorScore: null };
  }

  async throttleGenerationByTps(tokenCount, generationId = null) {
    if (this.options.maxTpsLimit === null || tokenCount <= 0) return;

    this.throttleQueue = this.throttleQueue.then(async () => {
      const nowMs = Date.now();
      const slotDurationMs = Math.ceil((tokenCount / this.options.maxTpsLimit) * 1000);
      const finishMs = Math.max(nowMs, this.nextAllowedAtMs) + slotDurationMs;
      const delayMs = Math.max(0, finishMs - nowMs);
      this.nextAllowedAtMs = finishMs;

      if (delayMs > 0) {
        if (generationId) {
          this.logger.debug(
            `Throttling generation ${generationId}: ${tokenCount} tokens, waiting ${delayMs} ms to respect ${this.options.maxTpsLimit} tps.`
          );
        }
        await sleep(delayMs);
      }
    });

    await this.throttleQueue;
  }

  async submitFaultedGeneration(generationId, reason = 'faulted', details = {}) {
    const failBody = {
      id: generationId,
      state: 'faulted',
      generation: 'faulted',
      seed: -1
    };

    for (let submitRetry = 0; submitRetry < MAX_SUBMIT_RETRIES; submitRetry++) {
      const response = await safePost({
        url: `${this.clusterUrl}/api/v2/generate/text/submit`,
        body: failBody,
        headers: this.hordeHeaders,
        timeoutMs: this.options.timeoutMs,
        logger: this.logger
      });

      if (!response.ok) {
        await sleep(10000);
        this.dashboard.setLastError(`faulted submit retry ${submitRetry + 1} for ${generationId}`);
        continue;
      }

      this.logger.info(`Submitted faulted state for ${generationId} (${reason}).`);
      this.dashboard.recordJobResult({
        jobId: generationId,
        status: reason,
        countAsProcessed: false,
        csamScore: Number.isFinite(details?.csamScore) ? details.csamScore : null
        ,
        openaiFlagged: typeof details?.openaiFlagged === 'boolean' ? details.openaiFlagged : null
      });
      this.dashboard.render();
      return true;
    }

    this.logger.error(`Failed to submit faulted state for ${generationId} (${reason}).`);
    this.dashboard.setLastError(`failed faulted submit for ${generationId}`);
    this.dashboard.recordJobResult({
      jobId: generationId,
      status: `${reason}_submit_failed`,
      countAsProcessed: false,
      csamScore: Number.isFinite(details?.csamScore) ? details.csamScore : null
      ,
      openaiFlagged: typeof details?.openaiFlagged === 'boolean' ? details.openaiFlagged : null
    });
    this.dashboard.render();
    return false;
  }

  async submitGeneration(submitBody, jobMetrics = null, submitMeta = {}) {
    for (let submitRetry = 0; submitRetry < MAX_SUBMIT_RETRIES; submitRetry++) {
      const response = await safePost({
        url: `${this.clusterUrl}/api/v2/generate/text/submit`,
        body: submitBody,
        headers: this.hordeHeaders,
        timeoutMs: this.options.timeoutMs,
        logger: this.logger
      });

      if (!response.ok) {
        await sleep(10000);
        this.dashboard.setLastError(`submit retry ${submitRetry + 1} for ${submitBody.id}`);
        continue;
      }

      let reward = Number(response.data?.reward);
      if (!Number.isFinite(reward) && submitMeta.allowMissingReward === true) {
        reward = 0;
      }
      if (!Number.isFinite(reward)) {
        this.logger.error('submitGeneration() invalid reward in response', response.data);
        await sleep(10000);
        continue;
      }

      this.logger.info(`Submitted ${submitBody.id} and contributed for ${reward.toFixed(2)}`);
      this.dashboard.recordJobResult({
        jobId: submitBody.id,
        status: submitMeta.statusOverride ?? 'sent',
        kudos: reward,
        tokens: Number.isFinite(jobMetrics?.tokens) ? jobMetrics.tokens : null,
        generationDurationMs: Number.isFinite(jobMetrics?.generationDurationMs)
          ? jobMetrics.generationDurationMs
          : null,
        countAsProcessed: true,
        csamScore: Number.isFinite(submitMeta.csamScore) ? submitMeta.csamScore : null
        ,
        openaiFlagged: typeof submitMeta.openaiFlagged === 'boolean' ? submitMeta.openaiFlagged : null
      });
      this.dashboard.render();
      return true;
    }

    return false;
  }

  async waitForPollSlot() {
    if (this.threadId < 0) return;
    if (this.options.threadPollStagger !== true) return;

    const refreshTimeMs = Number(this.options.refreshTime);
    const threadsCount = Number(this.options.threadsInt);
    if (!Number.isFinite(refreshTimeMs) || refreshTimeMs <= 0) return;
    if (!Number.isFinite(threadsCount) || threadsCount <= 1) return;

    const slotMs = refreshTimeMs / threadsCount;
    const threadPhaseMs = (this.threadId % threadsCount) * slotMs;
    const epochMs = Number.isFinite(this.runtime.pollEpochMs)
      ? this.runtime.pollEpochMs
      : Date.now();

    const nowMs = Date.now();
    const elapsedInCycleMs = Math.max(0, nowMs - epochMs) % refreshTimeMs;
    let waitMs = threadPhaseMs - elapsedInCycleMs;
    if (waitMs < 0) waitMs += refreshTimeMs;

    if (waitMs >= 10) {
      await sleep(Math.round(waitMs));
    }
  }

  async validateServer() {
    const healthUrl = `${this.options.serverUrl}${this.engine.healthUrl}`;
    if (
      this.serverStatusCache.lastStatus !== null &&
      Date.now() - this.serverStatusCache.lastRetrieved <= 30000
    ) {
      return this.serverStatusCache.lastStatus;
    }

    this.serverStatusCache.lastRetrieved = Date.now();

    try {
      const response = await axios.get(healthUrl, { headers: this.serverHeaders });
      this.serverStatusCache.lastStatus = response.status === 200;
      if (!this.serverStatusCache.lastStatus) {
        this.dashboard.setLastError(`health check status ${response.status}`);
      }
    } catch (error) {
      this.serverStatusCache.lastStatus = false;
      if (error.response?.status === 404) {
        this.dashboard.setLastError('health endpoint not found');
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        this.dashboard.setLastError('generation server unreachable');
      } else {
        this.dashboard.setLastError(`health check error: ${error.message}`);
      }
      this.logger.error(`Server health check failed for ${healthUrl}: ${error.message}`);
    }

    return this.serverStatusCache.lastStatus;
  }

  async textGenerationJob() {
    let currentId = null;
    let currentPayload = null;
    const interval = this.options.refreshTime;

    await this.waitForPollSlot();
    this.dashboard.setThreadState(this.threadId, 'polling');

    const serverOk = await this.validateServer();
    if (serverOk !== true) {
      await sleep(interval);
      return false;
    }

    const popBody = {
      name: this.options.workerName,
      models: [this.options.model],
      nsfw: this.options.nsfw,
      max_length: this.options.maxLengthInt,
      max_context_length: this.options.ctxInt,
      priority_usernames: ensureStringArray(this.options.priorityUsernames),
      threads: this.options.threadsInt,
      softprompts: [],
      bridge_agent: BRIDGE_AGENT
    };

    for (let loopRetry = 0; loopRetry < MAX_POP_RETRIES; loopRetry++) {
      const popResponse = await safePost({
        url: `${this.clusterUrl}/api/v2/generate/text/pop`,
        body: popBody,
        headers: this.hordeHeaders,
        timeoutMs: this.options.timeoutMs,
        logger: this.logger,
        includeMaintenanceLog: false
      });

      if (!popResponse.ok) {
        const isWorkerMaintenance =
          popResponse.status === 403 && popResponse.data?.rc === 'WorkerMaintenance';

        if (isWorkerMaintenance) {
          const message = popResponse.data?.message || 'Worker in maintenance';
          this.logger.warn(`Stable Horde worker maintenance: ${message}. Waiting ${interval}ms.`);
          this.dashboard.stats.maintenanceMode = true;
          this.dashboard.setThreadState(this.threadId, 'maintenance');
          this.dashboard.setLastError('worker maintenance mode');
          await sleep(interval);
          return true;
        }

        this.dashboard.stats.maintenanceMode = false;
        this.dashboard.setThreadState(this.threadId, 'retrying-pop');
        await sleep(interval);
        continue;
      }

      this.dashboard.stats.maintenanceMode = false;
      currentId = popResponse.data?.id;
      currentPayload = popResponse.data?.payload;

      if (!currentId) {
        this.dashboard.setThreadState(this.threadId, 'idle');
        await sleep(interval);
        return true;
      }

      if (!currentPayload?.max_length) currentPayload.max_length = 80;
      if (!currentPayload?.max_context_length) currentPayload.max_context_length = 1024;

      this.logger.info(
        `New job received from ${this.clusterUrl} for ${currentPayload.max_length} tokens and ${currentPayload.max_context_length} max context.`
      );
      this.dashboard.setThreadState(this.threadId, 'generating', currentId);
      this.dashboard.markJobReceived(currentId);
      logPromptForAudit({
        outputPromptFile: this.options.outputPrompt,
        jobId: currentId,
        prompt: currentPayload.prompt,
        logger: this.logger
      });
      this.dashboard.render();
      break;
    }

    if (!currentId) {
      this.dashboard.setThreadState(this.threadId, 'idle');
      return false;
    }

    const csamDecision = await this.evaluateCsam(currentPayload.prompt);
    if (csamDecision.blocked) {
      this.dashboard.stats.csamTriggers += 1;
      logCsamTriggerForAudit({
        logFile: this.options.logFile,
        jobId: currentId,
        reason: csamDecision.reason,
        mode: csamDecision.mode,
        threshold: null,
        openaiMinorScore: csamDecision.openaiMinorScore ?? null,
        prompt: currentPayload.prompt
      });
      this.dashboard.setThreadState(this.threadId, 'csam-block', currentId);
      this.dashboard.render();
      const csamScore = Number.isFinite(csamDecision.openaiMinorScore)
        ? csamDecision.openaiMinorScore
        : null;
      const openaiFlagged = typeof csamDecision.openaiFlagged === 'boolean'
        ? csamDecision.openaiFlagged
        : null;

      const isPositive = csamDecision.reason === 'csam_regex' || csamDecision.reason === 'csam_openai';
      const shouldRespond = isPositive && this.options.csamPositiveAction === 'respond';

      let csamResult;
      if (shouldRespond) {
        const responseText =
          this.options.csamBlockedResponse ||
          'Your request has been filtered by this worker safety policy.';
        const metadataRef =
          this.options.csamMetadataRef ||
          'omni-moderation-latest sexual/minors';
        const csamSubmitBody = {
          id: currentId,
          generation: responseText,
          state: 'csam',
          gen_metadata: [
            {
              type: 'censorship',
              value: 'csam',
              ref: metadataRef
            }
          ]
        };
        csamResult = await this.submitGeneration(
          csamSubmitBody,
          null,
          { statusOverride: 'csam_responded', csamScore, openaiFlagged, allowMissingReward: true }
        );
        if (!csamResult) {
          csamResult = await this.submitFaultedGeneration(currentId, 'csam_response_submit_failure', {
            csamScore,
            openaiFlagged
          });
        }
      } else {
        csamResult = await this.submitFaultedGeneration(currentId, csamDecision.reason, {
          csamScore,
          openaiFlagged
        });
      }
      this.dashboard.setThreadState(this.threadId, 'idle');
      return csamResult;
    }

    if (this.options.enforceCtxLimit) {
      const maxResponseTokens = Number.isFinite(currentPayload.max_length)
        ? currentPayload.max_length
        : this.options.maxLengthInt;
      const maxPromptTokens = this.options.ctxInt - Math.max(0, maxResponseTokens);
      const promptTokens = await this.countPromptTokens(currentPayload.prompt);

      if (!Number.isFinite(maxPromptTokens) || maxPromptTokens <= 0 || promptTokens > maxPromptTokens) {
        this.dashboard.setLastError(
          `ctx limit: prompt ${promptTokens} > allowed ${Math.max(0, maxPromptTokens)}`
        );
        this.dashboard.setThreadState(this.threadId, 'ctx-limit', currentId);
        this.dashboard.render();
        await this.submitFaultedGeneration(currentId, 'ctx_limit');
        this.dashboard.setThreadState(this.threadId, 'idle');
        return true;
      }
    }

    let serverRequest = await this.engine.generatePayload(
      currentPayload,
      this.options.serverUrl,
      this.serverHeaders
    );

    if (this.options.serverModel) {
      serverRequest.model = this.options.serverModel;
    }

    if (this.engine.tokenize && this.engine.detokenize) {
      const tokens = await this.engine.tokenize(
        currentPayload.prompt,
        this.options.serverUrl,
        this.serverHeaders
      );

      if (tokens) {
        const maxPromptTokens =
          (currentPayload.max_context_length || 2048) - (currentPayload.max_length || 256);

        if (tokens.length > maxPromptTokens) {
          const half = Math.floor(maxPromptTokens / 2);
          const trimmedTokens = [...tokens.slice(0, half), ...tokens.slice(-half)];
          const newPrompt = await this.engine.detokenize(
            trimmedTokens,
            this.options.serverUrl,
            this.serverHeaders
          );
          if (newPrompt) {
            this.logger.info(
              `CLE trimmed prompt from ${tokens.length} to ${trimmedTokens.length} tokens`
            );
            serverRequest.prompt = newPrompt;
          }
        }
      }
    }

    const generateUrl = `${this.options.serverUrl}${this.engine.generateUrl}`;
    const generationStartedAtMs = Date.now();

    for (let loopRetry = 0; loopRetry < MAX_GENERATION_RETRIES; loopRetry++) {
      const generationResponse = await safePost({
        url: generateUrl,
        body: serverRequest,
        headers: this.serverHeaders,
        timeoutMs: this.options.timeoutMs,
        logger: this.logger
      });

      if (!generationResponse.ok) {
        this.logger.error('Generation problem, will try again...');
        this.dashboard.setThreadState(this.threadId, 'retrying-generation', currentId);
        this.dashboard.setLastError(`generation retry ${loopRetry + 1} for ${currentId}`);
        await sleep(interval);
        continue;
      }

      this.dashboard.setThreadState(this.threadId, 'submitting', currentId);

      let generation;
      try {
        generation = this.engine.extractGeneration(generationResponse.data, currentPayload.prompt);
      } catch (error) {
        this.logger.error('Generation parse error', { error: error.message, data: generationResponse.data });
        await sleep(interval);
        continue;
      }

      const generatedTokens = await this.countGenerationTokens(generation, currentPayload.max_length);
      const generationDurationMs = Date.now() - generationStartedAtMs;
      await this.throttleGenerationByTps(generatedTokens, currentId);

      const submitOk = await this.submitGeneration(
        { id: currentId, generation },
        { tokens: generatedTokens, generationDurationMs },
        {
          csamScore: Number.isFinite(csamDecision.openaiMinorScore)
            ? csamDecision.openaiMinorScore
            : null,
          openaiFlagged: typeof csamDecision.openaiFlagged === 'boolean'
            ? csamDecision.openaiFlagged
            : null
        }
      );

      if (!submitOk) {
        this.dashboard.setLastError(`submit failed for ${currentId}`);
        this.dashboard.setThreadState(this.threadId, 'submit-failed', currentId);
        await this.submitFaultedGeneration(currentId, 'submit_failure');
        return false;
      }

      this.dashboard.setThreadState(this.threadId, 'idle');
      return true;
    }

    this.logger.error(`Generation ${currentId} failed after retries.`);
    this.dashboard.setLastError(`generation failed for ${currentId}`);
    this.dashboard.setThreadState(this.threadId, 'generation-failed', currentId);
    await this.submitFaultedGeneration(currentId, 'generation_failure');
    return false;
  }

  async run() {
    let startTime = Date.now();

    while (this.runtime.running) {
      let result = null;
      try {
        result = await this.textGenerationJob();
      } catch (error) {
        this.logger.error(`Thread ${this.threadId} failed`, error);
        this.dashboard.setThreadState(this.threadId, 'error');
        result = null;
      }

      const now = Date.now();
      this.dashboard.stats.lastRuntimeMs = now - startTime;
      this.dashboard.render();
      startTime = now;

      if (result !== true) {
        this.runtime.failedRequestsInARow += 1;
        if (this.runtime.failedRequestsInARow >= this.runtime.maxFailedRequests) {
          this.logger.error('Failed too many requests in a row, aborting bridge...');
          this.runtime.running = false;
        }
      } else {
        this.runtime.failedRequestsInARow = 0;
      }
    }

    this.logger.info(`Thread ${this.threadId} shutting down.`);
  }
}
