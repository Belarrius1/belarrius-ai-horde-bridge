import { parseConfig } from './config.js';
import { MAX_FAILED_REQUESTS } from './constants.js';
import { BridgeDashboard } from './dashboard.js';
import { buildEngines } from './engines.js';
import { safeGet, safePut } from './http.js';
import { createLogger } from './logger.js';
import { BridgeWorker } from './worker.js';

function buildServerHeaders(serverEngine, serverApiKey) {
  const key = String(serverApiKey ?? '').trim();
  if (!key) return {};

  const engine = String(serverEngine ?? '').trim().toLowerCase();
  if (['oobabooga', 'textgenwebui', 'oogabooga'].includes(engine)) {
    return {
      Authorization: /^Bearer\s+/i.test(key) ? key : `Bearer ${key}`
    };
  }

  return { Authorization: key };
}

async function main() {
  let options;
  try {
    options = parseConfig();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const logger = createLogger(options.logFile);
  const engines = buildEngines(logger);
  const engine = engines[options.serverEngine];

  if (!engine) {
    logger.error(`Unsupported serverEngine "${options.serverEngine}" in config.yaml`);
    process.exit(1);
  }

  if (!Number.isFinite(options.threadsInt) || options.threadsInt <= 0) {
    logger.error('"threads" must be a positive integer in config.yaml');
    process.exit(1);
  }

  if (!Number.isFinite(options.ctxInt) || options.ctxInt <= 0) {
    logger.error('"ctx" must be a positive integer in config.yaml');
    process.exit(1);
  }

  if (!Number.isFinite(options.maxLengthInt) || options.maxLengthInt <= 0) {
    logger.error('"maxLength" must be a positive integer in config.yaml');
    process.exit(1);
  }

  const hordeHeaders = { apikey: options.AiHordeApiKey };
  const hordeInfoHeaders = {
    'X-Api-Key': options.AiHordeApiKey,
    apikey: options.AiHordeApiKey
  };
  const serverHeaders = buildServerHeaders(options.serverEngine, options.serverApiKey);

  const dashboard = new BridgeDashboard({
    logger,
    options,
    clusterUrl: options.clusterUrl,
    hordeHeaders: hordeInfoHeaders
  });

  const runtime = {
    running: true,
    failedRequestsInARow: 0,
    maxFailedRequests: MAX_FAILED_REQUESTS,
    pollEpochMs: Date.now()
  };
  let sigintCount = 0;

  function shutdown(reason, error) {
    if (!runtime.running) return;

    runtime.running = false;
    if (error) {
      logger.error(reason, error);
      dashboard.setLastError(`${reason}: ${error.message ?? error}`);
    } else {
      logger.warn(reason);
      dashboard.setLastError(reason);
    }
    dashboard.stop();
  }

  process.on('SIGINT', () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      runtime.running = false;
      dashboard.requestGracefulShutdown();
      dashboard.setLastError('graceful shutdown requested');
      dashboard.render();
      return;
    }

    dashboard.stop();
    process.exit(130);
  });
  process.on('uncaughtException', (error) => shutdown('Uncaught exception', error));
  process.on('unhandledRejection', (error) => shutdown('Unhandled rejection', error));

  if (options.workerId && options.workerInfo) {
    const workerInfoUrl = `${options.clusterUrl}/api/v2/workers/${encodeURIComponent(options.workerId)}`;
    const workerInfoResponse = await safePut({
      url: workerInfoUrl,
      body: { info: options.workerInfo.slice(0, 500) },
      headers: hordeInfoHeaders,
      timeoutMs: 15000,
      logger
    });

    if (workerInfoResponse.ok) {
      logger.info(`Worker description updated for worker ${options.workerId}.`);
      const verifyResponse = await safeGet({
        url: workerInfoUrl,
        headers: hordeInfoHeaders,
        timeoutMs: 15000,
        logger
      });
      if (verifyResponse.ok) {
        const appliedInfo = verifyResponse.data?.info;
        if (typeof appliedInfo === 'string' && appliedInfo.trim().length > 0) {
          logger.info(`Worker info is visible via API: "${appliedInfo}"`);
        } else {
          logger.warn('Worker info PUT accepted, but "info" is not visible in worker GET response.');
        }
      } else {
        logger.warn('Worker info PUT accepted, but verification GET failed.');
      }
    } else {
      logger.warn(`Failed to update worker description for worker ${options.workerId}.`);
    }
  }

  logger.info('Checking server is up...');

  const probeWorker = new BridgeWorker({
    threadId: -1,
    logger,
    options,
    engine,
    dashboard,
    runtime,
    clusterUrl: options.clusterUrl,
    hordeHeaders,
    serverHeaders
  });

  const healthy = await probeWorker.validateServer();
  if (!healthy) {
    logger.error(`Something seems wrong with ${options.serverUrl}`);
    process.exit(1);
  }

  logger.info(`Spawning ${options.threadsInt} worker threads.`);

  const workers = Array.from({ length: options.threadsInt }, (_, threadId) => {
    return new BridgeWorker({
      threadId,
      logger,
      options,
      engine,
      dashboard,
      runtime,
      clusterUrl: options.clusterUrl,
      hordeHeaders,
      serverHeaders
    });
  });

  dashboard.start();
  await Promise.all(workers.map((worker) => worker.run()));
  dashboard.stop();
  logger.info('Worker threads have all exited.');
}

await main();
