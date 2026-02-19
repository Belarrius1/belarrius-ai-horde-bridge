import axios from 'axios';

export async function safePost({ url, body, headers = {}, timeoutMs = 30000, logger, includeMaintenanceLog = true }) {
  try {
    const response = await axios.post(url, body, { headers, timeout: timeoutMs });
    response.ok = true;
    return response;
  } catch (error) {
    if (error.response) {
      const isWorkerMaintenance =
        error.response.status === 403 &&
        error.response.data?.rc === 'WorkerMaintenance';

      if (isWorkerMaintenance && includeMaintenanceLog) {
        logger.info('safePost() WorkerMaintenance', { url, data: error.response.data });
      } else {
        logger.error(`safePost() SERVER ERROR ${error.response.status}`, {
          url,
          body,
          response: error.response.data
        });
      }

      error.response.ok = false;
      return error.response;
    }

    logger.error('safePost() CONNECT ERROR', { url, body, error: error.message });
    return { ok: false, error };
  }
}

export async function safeGet({ url, headers = {}, timeoutMs = 30000, logger }) {
  try {
    const response = await axios.get(url, { headers, timeout: timeoutMs });
    response.ok = true;
    return response;
  } catch (error) {
    if (error.response) {
      logger.error(`safeGet() SERVER ERROR ${error.response.status}`, { url, response: error.response.data });
      error.response.ok = false;
      return error.response;
    }

    logger.error('safeGet() CONNECT ERROR', { url, error: error.message });
    return { ok: false, error };
  }
}

export async function safePut({ url, body, headers = {}, timeoutMs = 30000, logger }) {
  try {
    const response = await axios.put(url, body, { headers, timeout: timeoutMs });
    response.ok = true;
    return response;
  } catch (error) {
    if (error.response) {
      logger.error(`safePut() SERVER ERROR ${error.response.status}`, { url, body, response: error.response.data });
      error.response.ok = false;
      return error.response;
    }

    logger.error('safePut() CONNECT ERROR', { url, body, error: error.message });
    return { ok: false, error };
  }
}
