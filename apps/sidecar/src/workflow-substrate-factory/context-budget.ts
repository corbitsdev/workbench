// Best-effort per-model context-window budget for the workbench
// director's compaction gate (CL-6204).
//
// Reads the same `numCtx` override shape `@corbits/ollama-adapter`
// resolves against a live request (`OllamaAdapterConfig`'s
// `default`/`perModel` bag) directly off `InferenceSource.quirks`, so a
// deployment that already pins a per-model `num_ctx` for Ollama gets
// that same number as its compaction budget instead of a second,
// drifting constant. `quirks` is `unknown` at this boundary (an
// operator-authored, per-source passthrough bag), so every read here is
// defensive rather than a validating parse: an unrecognized shape (every
// non-Ollama source today) falls back to a conservative default sized
// for the smallest models this repo deploys against, rather than
// throwing or silently trusting a shape the adapter itself doesn't own
// at this call site.
//
// Token counts are estimated from character counts (`CHARS_PER_TOKEN_ESTIMATE`)
// -- no tokenizer is available at this layer -- so the budget is
// deliberately conservative (see `COMPACTION_HEADROOM`), leaving room
// for the system prompt, tool definitions, and the model's own reply
// inside the same window.

const DEFAULT_CONTEXT_BUDGET_TOKENS = 8_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const COMPACTION_HEADROOM = 0.6;

function readNumCtxFromBag(bag: Record<string, unknown>): number | undefined {
  const numCtx = bag.numCtx;
  return typeof numCtx === "number" && numCtx > 0 ? numCtx : undefined;
}

/**
 * Best-effort read of a per-model `numCtx` off an `InferenceSource.quirks`
 * bag shaped like `@corbits/ollama-adapter`'s `OllamaAdapterConfig`
 * (`{ default?: { numCtx? }, perModel?: { [model]: { numCtx? } } }`).
 * Returns `undefined` for any other shape rather than throwing --
 * `quirks` is provider-specific and most sources carry none of this.
 */
export function readNumCtxHint(
  quirks: unknown,
  model: string,
): number | undefined {
  if (typeof quirks !== "object" || quirks === null) {
    return undefined;
  }
  const bag = quirks as Record<string, unknown>;
  const perModel = bag.perModel;
  if (typeof perModel === "object" && perModel !== null) {
    const entry = (perModel as Record<string, unknown>)[model];
    if (typeof entry === "object" && entry !== null) {
      const fromPerModel = readNumCtxFromBag(entry as Record<string, unknown>);
      if (fromPerModel !== undefined) {
        return fromPerModel;
      }
    }
  }
  const base = bag.default;
  if (typeof base === "object" && base !== null) {
    return readNumCtxFromBag(base as Record<string, unknown>);
  }
  return undefined;
}

/**
 * Resolve the compaction budget, in characters, for one `InferenceSource`.
 * Applies `COMPACTION_HEADROOM` on top of the resolved (or default)
 * `numCtx` so compaction fires with room left in the window, not at its
 * hard edge.
 */
export function resolveContextBudgetChars(
  quirks: unknown,
  model: string,
): number {
  const numCtx = readNumCtxHint(quirks, model) ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  return Math.floor(numCtx * CHARS_PER_TOKEN_ESTIMATE * COMPACTION_HEADROOM);
}

/**
 * The raw (no-headroom) character budget for one source -- the point
 * past which content can no longer be assumed to fit the model's window
 * at all, used to detect the unrecoverable case where even the turns a
 * compactor must keep verbatim are already too large.
 */
export function resolveHardContextLimitChars(
  quirks: unknown,
  model: string,
): number {
  const numCtx = readNumCtxHint(quirks, model) ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  return Math.floor(numCtx * CHARS_PER_TOKEN_ESTIMATE);
}
