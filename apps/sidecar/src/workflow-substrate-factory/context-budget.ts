// Per-model context-window budget for the workbench director's
// compaction gate.
//
// Window size is the resolved model's advertised native context, not a
// baked 8k-token (32k-char) cap:
//
//   1. `InferenceSource.quirks` -- the same `numCtx` override shape
//      `@corbits/ollama-adapter` resolves (`OllamaAdapterConfig`'s
//      `default`/`perModel` bag), plus a few other common token-window
//      field names operators actually pin.
//   2. The pinned catalog's advertised native window for that model
//      name (Ollama table entries and hosted-family prefixes).
//   3. A modern hosted-model fallback (128k tokens), used only when
//      neither quirks nor the catalog name the model. Compact (see
//      `COMPACTION_HEADROOM`) remains the safety net inside that
//      window; `CONTEXT_OVERFLOW_MESSAGE` is reserved for the hard
//      edge.
//
// `quirks` is `unknown` at this boundary (an operator-authored,
// per-source passthrough bag), so every read here is defensive rather
// than a validating parse.
//
// Token counts are estimated from character counts
// (`CHARS_PER_TOKEN_ESTIMATE`) -- no tokenizer is available at this
// layer -- so the budget is deliberately conservative (see
// `COMPACTION_HEADROOM`), leaving room for the system prompt, tool
// definitions, and the model's own reply inside the same window.

const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const COMPACTION_HEADROOM = 0.6;

// Exact names from `@corbits/inference-catalog`'s Ollama native-window
// table, then longest-prefix families for hosted catalog models.
// Longest prefix wins so `gpt-4.1` is not swallowed by `gpt-4`.
const ADVERTISED_CONTEXT_WINDOWS: readonly (readonly [string, number])[] = [
  ["qwen3.5:9b-mlx", 32_768],
  ["qwen3.8:27b", 32_768],
  ["llama3.1:8b", 131_072],
  ["gpt-oss:20b", 131_072],
  ["gpt-4-turbo", 128_000],
  ["gpt-4.1", 1_047_576],
  ["llama3.1", 131_072],
  ["gpt-oss", 131_072],
  ["gpt-4o", 128_000],
  ["claude", 200_000],
  ["gemini", 1_048_576],
  ["gpt-5", 400_000],
  ["gpt-4", 8_192],
  ["grok", 256_000],
  ["qwen3", 32_768],
  ["llama", 131_072],
  ["kimi", 128_000],
  ["deepseek", 128_000],
  ["minimax", 128_000],
  ["glm", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4", 200_000],
];

function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function readWindowFromBag(bag: Record<string, unknown>): number | undefined {
  return (
    positiveTokenCount(bag.numCtx) ??
    positiveTokenCount(bag.contextWindow) ??
    positiveTokenCount(bag.contextLength) ??
    positiveTokenCount(bag.maxContextTokens)
  );
}

function catalogModelKey(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Advertised native context window in tokens for a catalog model name.
 * Exact Ollama table entries win; otherwise the longest matching hosted
 * family prefix. `undefined` if this module has no published window for
 * the name.
 */
export function advertisedContextWindowTokens(
  model: string,
): number | undefined {
  const key = catalogModelKey(model);
  if (key.length === 0) {
    return undefined;
  }
  let best: { prefixLength: number; tokens: number } | undefined;
  for (const [prefix, tokens] of ADVERTISED_CONTEXT_WINDOWS) {
    if (key === prefix) {
      return tokens;
    }
    if (
      key.startsWith(prefix) &&
      (best === undefined || prefix.length > best.prefixLength)
    ) {
      best = { prefixLength: prefix.length, tokens };
    }
  }
  return best?.tokens;
}

/**
 * Best-effort read of a per-model window hint off an
 * `InferenceSource.quirks` bag. Understands `@corbits/ollama-adapter`'s
 * `OllamaAdapterConfig` (`{ default?: { numCtx? }, perModel?: { [model]:
 * { numCtx? } } }`) and a few other common token-window field names.
 * Returns `undefined` for any unrecognized shape rather than throwing.
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
      const fromPerModel = readWindowFromBag(entry as Record<string, unknown>);
      if (fromPerModel !== undefined) {
        return fromPerModel;
      }
    }
  }
  const base = bag.default;
  if (typeof base === "object" && base !== null) {
    const fromDefault = readWindowFromBag(base as Record<string, unknown>);
    if (fromDefault !== undefined) {
      return fromDefault;
    }
  }
  return readWindowFromBag(bag);
}

/**
 * Resolved context window in tokens for one `InferenceSource`: quirks
 * pin, then the advertised catalog window, then the hosted-model
 * fallback. Compact headroom is applied by the char-budget helpers,
 * not here.
 */
export function resolveContextWindowTokens(
  quirks: unknown,
  model: string,
): number {
  return (
    readNumCtxHint(quirks, model) ??
    advertisedContextWindowTokens(model) ??
    FALLBACK_CONTEXT_WINDOW_TOKENS
  );
}

function toChars(tokens: number, headroom: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN_ESTIMATE * headroom);
}

/**
 * Resolve the compaction budget, in characters, for one `InferenceSource`.
 * Applies `COMPACTION_HEADROOM` on top of the resolved window so
 * compaction fires with room left, not at the hard edge.
 */
export function resolveContextBudgetChars(
  quirks: unknown,
  model: string,
): number {
  return toChars(
    resolveContextWindowTokens(quirks, model),
    COMPACTION_HEADROOM,
  );
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
  return toChars(resolveContextWindowTokens(quirks, model), 1);
}
