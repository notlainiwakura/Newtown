/**
 * Logging utilities using pino
 */

import pino from 'pino';
import type { LoggingConfig } from '../types/config.js';

let loggerInstance: pino.Logger | null = null;

export function createLogger(config: LoggingConfig): pino.Logger {
  const options: pino.LoggerOptions = {
    level: config.level,
  };

  const targets: pino.TransportTargetOptions[] = [];

  if (config.prettyPrint) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    });
  } else {
    targets.push({
      target: 'pino/file',
      options: { destination: 1 }, // stdout
    });
  }

  if (config.file) {
    targets.push({
      target: 'pino/file',
      options: { destination: config.file, mkdir: true },
    });
  }

  const transport = pino.transport({ targets });
  loggerInstance = pino(options, transport);

  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    // Create a default logger if none exists
    loggerInstance = pino({
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    });
  }
  return loggerInstance;
}

export function setLogger(logger: pino.Logger): void {
  loggerInstance = logger;
}
