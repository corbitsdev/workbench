import { type } from "arktype";
import { CATALOG_MODELS } from "../src/models";

/**
 * Regenerates the `contextWindow` values in `packages/catalog/src/models.ts`
 * from the live models.dev payload (`https://models.dev/api.json`), so the
 * per-model context windows in the static catalog are reproducible rather
 * than hand-guessed.
 *
 * models.dev keys its payload by provider id, then model id, and publishes
 * `limit.context` (max input+output tokens) per model — see
 * `@workbench/pricing`'s `ModelsDevModelSchema` for the sibling `cost` shape
 * this mirrors.
 *
 * Usage:
 *   bun run packages/catalog/scripts/regen-from-models-dev.ts
 *
 * This prints a `canonicalName -> contextWindow` report for every model
 * currently listed in `models.ts`, resolved against the fetched payload (bare
 * id match across all providers, falling back to the largest context window
 * reported for that id when providers disagree). It does not write the file
 * automatically — the catalog is small and hand-curated, so the intended
 * workflow is: run the script, diff its report against `models.ts`, and
 * update any row whose window has drifted.
 */

const MODELS_DEV_URL = "https://models.dev/api.json";

const ModelsDevLimitSchema = type({
  "context?": "number",
});

const ModelsDevModelSchema = type({
  "id?": "string",
  "limit?": ModelsDevLimitSchema,
});

const ModelsDevProviderSchema = type({
  "id?": "string",
  models: {
    "[string]": ModelsDevModelSchema,
  },
});

const ModelsDevPayloadSchema = type({
  "[string]": ModelsDevProviderSchema,
});

async function fetchContextWindows(): Promise<Map<string, number>> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(
      `models.dev fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  const raw: unknown = await response.json();
  const parsed = ModelsDevPayloadSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`models.dev payload failed validation: ${parsed.summary}`);
  }

  const byModelId = new Map<string, number>();
  for (const provider of Object.values(parsed)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const modelId = model.id ?? modelKey;
      const context = model.limit?.context;
      if (context === undefined) continue;
      const existing = byModelId.get(modelId);
      if (existing === undefined || context > existing) {
        byModelId.set(modelId, context);
      }
    }
  }
  return byModelId;
}

async function main(): Promise<void> {
  const byModelId = await fetchContextWindows();

  for (const model of CATALOG_MODELS) {
    const resolved = byModelId.get(model.canonicalName);
    const status =
      resolved === undefined
        ? "NOT FOUND on models.dev"
        : resolved === model.contextWindow
          ? "unchanged"
          : `catalog has ${model.contextWindow}, models.dev has ${resolved}`;
    process.stdout.write(
      `${model.canonicalName}\t${resolved ?? "?"}\t${status}\n`,
    );
  }
}

await main();
