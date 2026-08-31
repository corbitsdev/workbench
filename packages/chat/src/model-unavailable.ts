// Named consumer error for a wake/launch whose tenant catalog cannot
// resolve an inference source. `InferenceResolutionError`'s own
// `message` is a log string (launch label, resolution reason, seed
// instructions) and must never land on `agent_turns.error`, a timeline
// notice, or an HTTP 500 body.
import { InferenceResolutionError } from "@corbits/folded-runs";

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
