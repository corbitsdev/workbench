export const isDev =
  import.meta.env.DEV || process.env.NODE_ENV !== "production";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    debug: isDev
      ? (message, ...args) => console.debug(`${tag} ${message}`, ...args)
      : () => {},
    info: isDev
      ? (message, ...args) => console.info(`${tag} ${message}`, ...args)
      : () => {},
    warn: (message, ...args) => console.warn(`${tag} ${message}`, ...args),
    error: (message, ...args) => console.error(`${tag} ${message}`, ...args),
  };
}

export { createLogger };
export const logger = createLogger("gtm");
