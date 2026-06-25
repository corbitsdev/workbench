import { flushSentry } from "./setup";

type ErrorLogger = {
  error: (message: string, properties?: Record<string, unknown>) => void;
};

export function toLoggedError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

export async function reportLoggedError(
  log: ErrorLogger,
  message: string,
  err: unknown,
  properties: Record<string, unknown> = {},
): Promise<void> {
  log.error(message, { ...properties, error: toLoggedError(err) });
  await flushSentry();
}
