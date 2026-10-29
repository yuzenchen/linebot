import { pino, type Logger, type LoggerOptions } from 'pino';
import { getConfig } from './config.js';

const redactPaths = [
  'req.headers.authorization',
  '*.channelAccessToken',
  '*.channelSecret',
  '*.apiKey',
  '*.authorization',
];

export function createLogger(level: LoggerOptions['level'] = 'info'): Logger {
  const options: LoggerOptions = { level, redact: { paths: redactPaths, censor: '[REDACTED]' } };
  if (process.env.NODE_ENV !== 'production') {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  return pino(options);
}

let cached: Logger | undefined;

export function getLogger(): Logger {
  cached ??= createLogger(getConfig().LOG_LEVEL);
  return cached;
}

/** Lazily-created logger; config is read on first use. */
export const logger: Logger = new Proxy({} as Logger, {
  get: (_t, prop) => {
    const target = getLogger();
    const value: unknown = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
