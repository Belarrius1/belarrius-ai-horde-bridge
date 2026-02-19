import { createLogger } from './src/logger.js';
import { buildEngines } from './src/engines.js';

const logger = createLogger('');
const servers = buildEngines(logger);

export default servers;
