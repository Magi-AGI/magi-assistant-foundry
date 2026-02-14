/**
 * Log sanitizer — strips secrets from all output.
 * Same pattern as magi-assistant-discord logger.
 */

import { inspect } from 'util';

const AUTHORIZATION_HEADER_PATTERN = /(?<=Authorization:\s*(?:Bearer\s+)?)\S+/gi;

// Dynamic secret redaction
const secretFragments: string[] = [];
let secretPattern: RegExp | null = null;

/** Register a secret value so it is redacted from all log output. */
export function registerSecret(secret: string): void {
  if (secret && secret.length >= 8) {
    secretFragments.push(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    secretPattern = new RegExp(secretFragments.join('|'), 'g');
  }
}

function sanitize(message: string): string {
  let result = message.replace(AUTHORIZATION_HEADER_PATTERN, '[REDACTED]');
  if (secretPattern) {
    result = result.replace(secretPattern, '[REDACTED]');
  }
  return result;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        const stack = arg.stack ?? arg.message;
        return sanitize(stack);
      }
      if (typeof arg === 'string') {
        return sanitize(arg);
      }
      return sanitize(inspect(arg, { depth: 3, breakLength: Infinity }));
    })
    .join(' ');
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(...args: unknown[]): void {
    console.log(`[${timestamp()}] [INFO]`, formatArgs(args));
  },
  warn(...args: unknown[]): void {
    console.warn(`[${timestamp()}] [WARN]`, formatArgs(args));
  },
  error(...args: unknown[]): void {
    console.error(`[${timestamp()}] [ERROR]`, formatArgs(args));
  },
  debug(...args: unknown[]): void {
    if (process.env.DEBUG) {
      console.debug(`[${timestamp()}] [DEBUG]`, formatArgs(args));
    }
  },
};
