import winston from 'winston';

const { combine, timestamp, cli, json } = winston.format;

export function createLogger(logFile = '') {
  const transports = [new winston.transports.Console({ format: cli(), level: 'error' })];
  if (typeof logFile === 'string' && logFile.trim().length > 0) {
    transports.push(new winston.transports.File({ filename: logFile.trim(), level: 'error' }));
  }

  return winston.createLogger({
    level: 'error',
    format: combine(timestamp(), json()),
    transports
  });
}

export function setConsoleLoggingEnabled(logger, enabled) {
  for (const transport of logger.transports) {
    if (transport instanceof winston.transports.Console) {
      transport.silent = !enabled;
    }
  }
}
