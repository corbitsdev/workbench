// Named consumer error for a wake/launch whose tenant catalog cannot
// resolve an inference source. `InferenceResolutionError`'s own
// `message` is a log string (launch label, resolution reason, seed
// instructions) and must never land on `agent_turns.error`, a timeline
// notice, or an HTTP 500 body.

/**
 * Thrown when the tenant catalog yields no launchable inference source.
 * The bare `resolutionMessage` is kept alongside the log `message` so
 * an HTTP boundary can map it without parsing the log-string.
 */
export class InferenceResolutionError extends Error {
  readonly resolutionMessage: string;
  /** Consumer-facing sentence an HTTP boundary can return verbatim. */
  readonly guidance: string;
  constructor(launchLabel: string, resolutionMessage: string) {
    super(
      `cannot resolve an inference source for ${launchLabel} ` +
        `(${resolutionMessage}); seed a tenant catalog source (provider, ` +
        `credential, catalog model/provider/offering) before launching`,
    );
    this.name = "InferenceResolutionError";
    this.resolutionMessage = resolutionMessage;
    this.guidance = "This agent's model isn't available here.";
  }
}

export const MODEL_UNAVAILABLE_CONSUMER_MESSAGE =
  "This agent's model isn't available here.";

/**
 * Thrown at wake (`wakeByAddress` / `ensureAwake`) in place of a raw
 * `InferenceResolutionError` so hub `onError` can map it to a 4xx via
 * `guidance`, and so `dispatchTurn` can close the turn with this same
 * sentence instead of the technical resolution dump.
 */
export class ModelUnavailableError extends Error {
  readonly guidance: string;
  constructor(cause?: unknown) {
    super(MODEL_UNAVAILABLE_CONSUMER_MESSAGE);
    this.name = "ModelUnavailableError";
    this.guidance = MODEL_UNAVAILABLE_CONSUMER_MESSAGE;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isModelUnavailableCause(cause: unknown): boolean {
  if (cause instanceof ModelUnavailableError) return true;
  if (cause instanceof InferenceResolutionError) return true;
  return (
    cause instanceof Error && cause.cause instanceof InferenceResolutionError
  );
}

/** Turn-row `error` text: never a raw `InferenceResolutionError.message`. */
export function consumerTurnError(err: unknown): string {
  if (isModelUnavailableCause(err)) return MODEL_UNAVAILABLE_CONSUMER_MESSAGE;
  return err instanceof Error ? err.message : String(err);
}

/** Wake/sendMail: wrap catalog resolution failure as the named consumer error. */
export function wrapWakeInferenceError(error: unknown): unknown {
  if (error instanceof InferenceResolutionError) {
    return new ModelUnavailableError(error);
  }
  return error;
}
