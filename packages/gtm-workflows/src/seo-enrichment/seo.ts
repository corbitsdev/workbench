import { getLogger } from '@intx/log';
import type { ImageBlock } from '@intx/types/runtime';
import type { WorkflowArtifactDraft } from '@workbench/workflow-core';
import {
  buildSelectionArtifactContent,
  createSelectionArtifactDraft,
  SELECTION_ARTIFACT_KIND,
} from '../resource-enrichment';
import { SEO_SELECTION_FIELDS, SEO_VARIANT_COUNT } from './constants';
import { loadProductImage } from './image';
import { defaultSystemPrompt } from './prompts';
import type { SeoResourceRow } from './types';

export { SEO_SELECTION_FIELDS, SEO_VARIANT_COUNT };

const log = getLogger(['workflow', 'seo-enrichment']);

// The JSON Schema enforced on the model's response: exactly five variants of
// each field. Omits `additionalProperties` (Gemini rejects it); the OpenAI path
// adds it back when strict mode is used.
export const SEO_SCHEMA = {
  type: 'object',
  required: ['sku_id', 'seo_titles', 'seo_descriptions', 'product_summaries'],
  properties: {
    sku_id: { type: 'string' },
    seo_titles: {
      type: 'array',
      items: { type: 'string' },
      minItems: SEO_VARIANT_COUNT,
      maxItems: SEO_VARIANT_COUNT,
    },
    seo_descriptions: {
      type: 'array',
      items: { type: 'string' },
      minItems: SEO_VARIANT_COUNT,
      maxItems: SEO_VARIANT_COUNT,
    },
    product_summaries: {
      type: 'array',
      items: { type: 'string' },
      minItems: SEO_VARIANT_COUNT,
      maxItems: SEO_VARIANT_COUNT,
    },
  },
} as const;

export interface SeoPayload {
  sku_id: string;
  seo_titles: string[];
  seo_descriptions: string[];
  product_summaries: string[];
}

const SEO_ARRAY_FIELDS = ['seo_titles', 'seo_descriptions', 'product_summaries'] as const;

export type SeoValidation = { ok: true; payload: SeoPayload } | { ok: false; errors: string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The 5/5/5 + schema gate: the single source of truth the run asserts against.
// Returns clear per-field errors so a broken payload is demonstrably red.
export function validateSeoPayload(value: unknown): SeoValidation {
  if (!isRecord(value)) {
    return { ok: false, errors: ['payload is not an object'] };
  }
  const errors: string[] = [];

  const skuId = value['sku_id'];
  if (typeof skuId !== 'string' || skuId === '') {
    errors.push('sku_id must be a non-empty string');
  }

  const arrays: Record<(typeof SEO_ARRAY_FIELDS)[number], string[]> = {
    seo_titles: [],
    seo_descriptions: [],
    product_summaries: [],
  };
  for (const field of SEO_ARRAY_FIELDS) {
    const arr = value[field];
    if (!isStringArray(arr)) {
      errors.push(`${field} must be an array of strings`);
      continue;
    }
    if (arr.length !== SEO_VARIANT_COUNT) {
      errors.push(`${field} must have exactly ${SEO_VARIANT_COUNT} variants, got ${arr.length}`);
    }
    if (arr.some((s) => s.trim() === '')) {
      errors.push(`${field} must not contain empty variants`);
    }
    arrays[field] = arr;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      sku_id: typeof skuId === 'string' ? skuId : '',
      seo_titles: arrays.seo_titles,
      seo_descriptions: arrays.seo_descriptions,
      product_summaries: arrays.product_summaries,
    },
  };
}

// Parse a raw model reply and run it through the gate. A non-JSON reply or a
// shape violation throws loudly — the fan-out catches it and produces an
// error-state selection rather than aborting the batch.
export function parseSeoReply(text: string): SeoPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `generate output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const validation = validateSeoPayload(parsed);
  if (!validation.ok) {
    throw new Error(`generate output failed the 5/5/5 gate: ${validation.errors.join('; ')}`);
  }
  return validation.payload;
}

export function buildSeoResponseSeed(row: Pick<SeoResourceRow, 'productSlug'>): SeoPayload {
  return {
    sku_id: row.productSlug,
    seo_titles: [],
    seo_descriptions: [],
    product_summaries: [],
  };
}

// A concise, model-facing projection of the product plus the generate
// instruction. The full row carries ingest-only fields that would be noise.
export function buildSeoUserMessage(row: SeoResourceRow): string {
  const metadata = {
    sku_id: row.productSlug,
    suite: row.productSuiteName,
    product_name: row.productName,
    product_type: row.tertiaryCategory || row.subCategory || row.category,
    styles: row.styles,
    current_title: row.productMetadataTitle,
    current_description: row.productMetadataDescription,
    current_summary: row.summary,
  };
  return [
    `PRODUCT METADATA (JSON):\n${JSON.stringify(metadata, null, 2)}`,
    'Return one JSON object matching this exact shape and field names:',
    JSON.stringify(buildSeoResponseSeed(row), null, 2),
    `Fill each array with exactly ${SEO_VARIANT_COUNT} non-empty string variants.`,
  ].join('\n\n');
}

// Map a validated SEO payload onto a selection artifact draft (5 options per
// field, no pick yet).
export function buildSeoSelectionDraft(
  row: Pick<SeoResourceRow, 'productSlug'>,
  payload: SeoPayload
): WorkflowArtifactDraft {
  return createSelectionArtifactDraft({
    label: row.productSlug,
    fields: {
      Title: payload.seo_titles,
      Description: payload.seo_descriptions,
      Summary: payload.product_summaries,
    },
  });
}

// The single inference capability the enrich step needs, injected by the host
// (the hub binds it to a credential-backed multimodal call). Keeping it as a
// narrow function means the SEO domain logic — image fetch, prompt assembly,
// parsing, selection building — all lives here in the package, not the app.
export type SeoRowInference = (args: {
  systemPrompt: string;
  userMessage: string;
  image: ImageBlock;
}) => Promise<string>;

// Enrich one row end to end: fetch its image, assemble the prompt, run the
// injected inference, validate the 5/5/5 output, and build a selection draft.
// Any failure (missing image, inference error, schema violation) becomes an
// error-state selection so the caller's fan-out never aborts on one bad row.
export async function enrichSeoRow(
  row: SeoResourceRow,
  infer: SeoRowInference
): Promise<WorkflowArtifactDraft> {
  try {
    const image = await loadProductImage(row.imageLink);
    if (!image.ok) {
      log.warn('SEO row image unavailable', {
        productSlug: row.productSlug,
        reason: image.reason,
      });
      return buildErrorSelectionDraft(row, 'image unavailable');
    }
    const text = await infer({
      systemPrompt: defaultSystemPrompt(row),
      userMessage: buildSeoUserMessage(row),
      image: image.image,
    });
    return buildSeoSelectionDraft(row, parseSeoReply(text));
  } catch (err) {
    // Surface a category to the reviewer, not the raw provider/parse error
    // (which can carry model names, request ids, or rate-limit detail).
    const message = err instanceof Error ? err.message : String(err);
    const reason = /JSON|5\/5\/5/.test(message) ? 'response invalid' : 'enrichment failed';
    const error = err instanceof Error ? err : new Error(message);
    log.error('SEO row enrichment failed', {
      productSlug: row.productSlug,
      category: reason,
      error,
    });
    return buildErrorSelectionDraft(row, reason);
  }
}

// A failed row (image fetch, inference, or schema) becomes a selection carrying
// the reason as its sole, pre-decided option — surfaced to the reviewer and
// excluded from useful CSV columns without blocking the batch.
export function buildErrorSelectionDraft(
  row: Pick<SeoResourceRow, 'productSlug'>,
  reason: string
): WorkflowArtifactDraft {
  return {
    kind: SELECTION_ARTIFACT_KIND,
    title: row.productSlug,
    content: buildSelectionArtifactContent({
      label: row.productSlug,
      fields: { Error: [reason] },
      chosen: { Error: 0 },
    }),
    status: 'draft',
  };
}
