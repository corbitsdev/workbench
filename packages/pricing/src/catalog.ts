import { type } from "arktype";

/**
 * models.dev pricing integration.
 *
 * models.dev publishes an open pricing database at `https://models.dev/api.json`
 * keyed by provider id → `{ id, name, models: { modelId → { id, name, cost } } }`.
 * All `cost` figures are **US dollars per one million tokens**, split by billed
 * token class (`input`, `output`, `cache_read`, `cache_write`).
 *
 * The payload is untrusted external data, so it is parsed through
 * {@link ModelsDevPayloadSchema} at the hub boundary before we build the flat
 * {@link PriceCatalog} the rest of the app consumes.
 */

/** Divisor turning a per-million-token rate into a per-token rate. */
const TOKENS_PER_RATE_UNIT = 1_000_000;

// --- models.dev payload (untrusted, hub-boundary parse) -------------------

/**
 * Per-class dollar rates from a models.dev `cost` block. Every field is
 * optional — many models publish only some classes (e.g. embeddings have no
 * cache rates). Declared numeric so a non-number (a malformed payload) fails
 * the parse rather than silently coercing.
 */
export const ModelsDevCostSchema = type({
  "input?": "number",
  "output?": "number",
  "cache_read?": "number",
  "cache_write?": "number",
});

export const ModelsDevModelSchema = type({
  "id?": "string",
  "name?": "string",
  "cost?": ModelsDevCostSchema,
});

export const ModelsDevProviderSchema = type({
  "id?": "string",
  "name?": "string",
  models: {
    "[string]": ModelsDevModelSchema,
  },
});

/** Top-level models.dev payload: an object keyed by provider id. */
export const ModelsDevPayloadSchema = type({
  "[string]": ModelsDevProviderSchema,
});

export type ModelsDevPayload = typeof ModelsDevPayloadSchema.infer;

// --- flat catalog (our boundary type, crosses the hub → web API) ----------

/**
 * A single model's per-class rate in **dollars per million tokens**. A class
 * whose rate models.dev does not publish is `null`, never `0` — so the UI can
 * distinguish "free" from "unknown" and never fabricate a figure.
 */
export const ModelRateSchema = type({
  modelId: "string",
  provider: "string",
  providerName: "string",
  input: "number | null",
  output: "number | null",
  cacheRead: "number | null",
  cacheWrite: "number | null",
});

export type ModelRate = typeof ModelRateSchema.infer;

export const PriceCatalogSchema = type({
  source: "string",
  generatedAt: "string",
  // Bare-modelId → representative rate. Only carries an id that resolves to a
  // single rate across all providers; an id priced differently by two providers
  // is left OUT here and listed in `ambiguous` instead of showing one arbitrary
  // provider's (confidently wrong) figure.
  models: {
    "[string]": ModelRateSchema,
  },
  // Every priced variant keyed by `provider/modelId`, so a provider-qualified
  // telemetry name resolves to THAT provider's rate.
  qualified: {
    "[string]": ModelRateSchema,
  },
  // Bare ids offered by more than one provider at DIFFERENT rates — a bare
  // lookup for one of these is honestly "no rate", never a guessed provider.
  ambiguous: "string[]",
});

export type PriceCatalog = typeof PriceCatalogSchema.infer;

function costField(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function hasAnyRate(rate: ModelRate): boolean {
  return (
    rate.input !== null ||
    rate.output !== null ||
    rate.cacheRead !== null ||
    rate.cacheWrite !== null
  );
}

/** True when two rates carry the same per-class dollar figures. */
function sameRate(a: ModelRate, b: ModelRate): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

/**
 * Flattens a parsed models.dev payload into a resolvable {@link PriceCatalog}.
 *
 * Every priced variant is indexed provider-qualified (`provider/modelId`) so a
 * qualified telemetry name resolves to THAT provider's rate. In addition, bare
 * model ids are indexed for the common case where telemetry carries the bare id
 * — but only when the id resolves to a single rate: if two providers price the
 * same bare id DIFFERENTLY (e.g. an open-weight model served by several hosts),
 * the id is marked `ambiguous` and left out of the bare map, so a bare lookup is
 * honestly "no rate" rather than a confident-but-wrong figure from whichever
 * provider sorts first. Models with no priced class are omitted entirely.
 */
export function buildPriceCatalog(
  payload: ModelsDevPayload,
  source: string,
  generatedAt: string,
): PriceCatalog {
  const qualified: Record<string, ModelRate> = {};
  const variantsByBare = new Map<string, ModelRate[]>();

  for (const providerId of Object.keys(payload).sort()) {
    const provider = payload[providerId];
    if (provider === undefined) continue;
    const providerName = provider.name ?? provider.id ?? providerId;
    const resolvedProviderId = provider.id ?? providerId;

    for (const [modelKey, model] of Object.entries(provider.models)) {
      const modelId = model.id ?? modelKey;
      const cost = model.cost;
      const rate: ModelRate = {
        modelId,
        provider: resolvedProviderId,
        providerName,
        input: costField(cost?.input),
        output: costField(cost?.output),
        cacheRead: costField(cost?.cache_read),
        cacheWrite: costField(cost?.cache_write),
      };
      if (!hasAnyRate(rate)) continue;

      qualified[`${resolvedProviderId}/${modelId}`] = rate;
      const variants = variantsByBare.get(modelId);
      if (variants === undefined) {
        variantsByBare.set(modelId, [rate]);
      } else {
        variants.push(rate);
      }
    }
  }

  const models: Record<string, ModelRate> = {};
  const ambiguous: string[] = [];
  for (const [modelId, variants] of variantsByBare) {
    const first = variants[0]!;
    const allAgree = variants.every((v) => sameRate(v, first));
    if (allAgree) {
      models[modelId] = first;
    } else {
      ambiguous.push(modelId);
    }
  }
  ambiguous.sort();

  return { source, generatedAt, models, qualified, ambiguous };
}

/**
 * Resolves one of our telemetry model names to a models.dev rate.
 *
 * A provider-qualified name (`provider/model`) resolves to THAT provider's rate
 * (exact, then case-insensitive) — never a different provider's. A bare name
 * resolves via the bare index (exact, then case-insensitive), but a bare id
 * that is ambiguous across providers returns `null` rather than a guessed rate.
 * Returns `null` when nothing maps — the caller then shows tokens only and marks
 * the model unpriced. Never fabricates or misattributes a figure.
 */
export function resolveModelRate(
  catalog: PriceCatalog,
  modelName: string | null | undefined,
): ModelRate | null {
  if (modelName === null || modelName === undefined || modelName === "") {
    return null;
  }

  const slash = modelName.lastIndexOf("/");
  if (slash !== -1 && slash < modelName.length - 1) {
    const qualified = resolveExact(catalog.qualified, modelName);
    if (qualified !== null) return qualified;
    // Provider unknown to the catalog: fall back to the bare id (which still
    // returns null if that bare id is ambiguous across providers).
    return resolveBare(catalog, modelName.slice(slash + 1));
  }

  return resolveBare(catalog, modelName);
}

function resolveExact(
  index: Record<string, ModelRate>,
  key: string,
): ModelRate | null {
  const exact = index[key];
  if (exact !== undefined) return exact;
  const lower = key.toLowerCase();
  for (const [id, rate] of Object.entries(index)) {
    if (id.toLowerCase() === lower) return rate;
  }
  return null;
}

function resolveBare(catalog: PriceCatalog, bareId: string): ModelRate | null {
  const lower = bareId.toLowerCase();
  if (catalog.ambiguous.some((id) => id.toLowerCase() === lower)) {
    return null;
  }
  return resolveExact(catalog.models, bareId);
}

// --- cost math ------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Reasoning/thinking tokens (CL-2723). models.dev publishes no separate
   * `thinking` rate class — providers that bill reasoning tokens at all
   * (Anthropic extended thinking, OpenAI reasoning models) bill them at the
   * model's OUTPUT rate, so that is the rate this class prices against. This
   * is a documented modeling choice, not a fabricated rate: if a provider ever
   * bills thinking tokens differently, this is the one place to special-case
   * it.
   */
  thinkingTokens: number;
}

export interface TokenCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  total: number;
}

function classCost(tokens: number, ratePerMillion: number | null): number {
  if (ratePerMillion === null || tokens <= 0) return 0;
  return (tokens / TOKENS_PER_RATE_UNIT) * ratePerMillion;
}

/**
 * Computes per-class and total dollar cost for a usage bundle at a given rate.
 *
 * Each token class is priced independently from its own models.dev rate; a
 * class whose rate is `null` contributes `0`. Returns `null` when there is no
 * rate at all — the honest "unpriced model" signal, never a fabricated figure.
 */
export function computeCost(
  usage: TokenUsage,
  rate: ModelRate | null,
): TokenCost | null {
  if (rate === null) return null;
  const input = classCost(usage.inputTokens, rate.input);
  const output = classCost(usage.outputTokens, rate.output);
  const cacheRead = classCost(usage.cacheReadTokens, rate.cacheRead);
  const cacheWrite = classCost(usage.cacheWriteTokens, rate.cacheWrite);
  // Thinking tokens are priced at the output rate — see the TokenUsage doc.
  const thinking = classCost(usage.thinkingTokens, rate.output);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    thinking,
    total: input + output + cacheRead + cacheWrite + thinking,
  };
}

const EMPTY_COST: TokenCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
  total: 0,
};

/**
 * Label for usage telemetry that carries no model name (CL-2723). Such usage
 * can never be priced — routing it through `priceUsageRows` under this label
 * (rather than dropping it) forces it into `unpricedModels`/`hasUnpriced` so it
 * renders as "not priced"/"partial", never a silent, fabricated $0. The parens
 * keep it from colliding with any real models.dev id.
 */
export const UNKNOWN_MODEL_LABEL = "(unknown model)";

/** Row of per-model usage keyed by the telemetry model name. */
export interface ModelUsageRow extends TokenUsage {
  model: string;
}

export interface PricedUsage {
  cost: TokenCost;
  /** Models with usage but no models.dev rate — excluded from `cost`. */
  unpricedModels: string[];
  /** True when at least one model with usage could not be priced. */
  hasUnpriced: boolean;
}

/**
 * Sums dollar cost across a set of per-model usage rows, tracking which models
 * had no rate so the UI can flag partial coverage. Unpriced models contribute
 * their tokens to the token totals elsewhere but never a fabricated dollar.
 */
export function priceUsageRows(
  rows: ModelUsageRow[],
  catalog: PriceCatalog,
): PricedUsage {
  const cost: TokenCost = { ...EMPTY_COST };
  const unpriced = new Set<string>();

  for (const row of rows) {
    const rate = resolveModelRate(catalog, row.model);
    const rowCost = computeCost(row, rate);
    if (rowCost === null) {
      const usedTokens =
        row.inputTokens +
        row.outputTokens +
        row.cacheReadTokens +
        row.cacheWriteTokens +
        row.thinkingTokens;
      if (usedTokens > 0) unpriced.add(row.model);
      continue;
    }
    cost.input += rowCost.input;
    cost.output += rowCost.output;
    cost.cacheRead += rowCost.cacheRead;
    cost.cacheWrite += rowCost.cacheWrite;
    cost.thinking += rowCost.thinking;
    cost.total += rowCost.total;
  }

  const unpricedModels = [...unpriced].sort();
  return { cost, unpricedModels, hasUnpriced: unpricedModels.length > 0 };
}
