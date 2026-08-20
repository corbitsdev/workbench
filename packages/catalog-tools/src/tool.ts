// The `@corbits/catalog-tools` bundle: `list_model_concepts`,
// `pick_models`, and `estimate_run_cost`.
//
// The rule the whole bundle exists to enforce: an agent asks for a model by
// what the work needs — a kind of work, or the capabilities the work
// requires — and never by name. A model named from memory is a guess about
// a bench the agent cannot see; a concept is a question this bench can
// answer from its own connected providers, its own capability data, and its
// own prices.
//
// Every answer is an ordered chain, head first and fallbacks behind it, and
// every price is either real or reported as unknown. Nothing here invents a
// model, and nothing here reports a price of zero for something unpriced.
//
// All three tools read only, so none declares an `approval` key — the same
// call `@corbits/connections-tools` makes for `list_connections`.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { WIRE_CAPABILITIES, type Capability } from "@intx/types";
import { type } from "arktype";

import {
  fetchChain,
  fetchEstimate,
  listConcepts,
  type CatalogToolClientConfig,
  type ChainEntry,
  type ModelChainResult,
} from "./client";

export const LIST_MODEL_CONCEPTS_TOOL = "list_model_concepts";
export const PICK_MODELS_TOOL = "pick_models";
export const ESTIMATE_RUN_COST_TOOL = "estimate_run_cost";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach credential,
 * mirroring `@corbits/connections-tools`' `WorkflowConnectionEnv`. */
export interface WorkflowCatalogEnv extends BaseEnv {
  readonly hubCatalogUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const NEED_MESSAGE =
  "ask by either `concept` (a kind of work) or `capabilities` (the features the work needs) — exactly one, never both, and never a model name";

const NeedInput = type({
  "concept?": "string > 0",
  "capabilities?": type.enumerated(...WIRE_CAPABILITIES).array(),
}).narrow((need, ctx) => {
  const hasConcept = need.concept !== undefined;
  const hasCapabilities = need.capabilities !== undefined;
  return hasConcept === hasCapabilities ? ctx.mustBe(NEED_MESSAGE) : true;
});

const PickModelsInput = NeedInput.and({
  "order?": "'cheapest'|'catalog'",
  "limit?": "1 <= number <= 10",
});
type PickModelsInput = typeof PickModelsInput.infer;

const EstimateRunCostInput = NeedInput.and({
  expectedInputTokens: "number >= 0",
  expectedOutputTokens: "number >= 0",
});
type EstimateRunCostInput = typeof EstimateRunCostInput.infer;

const needProperties = {
  concept: {
    type: "string",
    description:
      "The kind of work, as an id from list_model_concepts (e.g. " +
      '"cheap-loop", "code-work"). Never a model name.',
  },
  capabilities: {
    type: "array",
    items: { type: "string", enum: [...WIRE_CAPABILITIES] },
    description:
      "The features the work needs on the wire. Use this instead of " +
      "concept when no kind of work fits.",
  },
} as const;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowCatalogEnv): CatalogToolClientConfig {
  return {
    hubCatalogUrl: env.hubCatalogUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

/** The need, as exactly one of the two forms the hub accepts. The input
 * schema has already rejected both-at-once and neither. */
function needOf(input: { concept?: string; capabilities?: Capability[] }): {
  concept?: string;
  capabilities?: readonly Capability[];
} {
  return input.concept !== undefined
    ? { concept: input.concept }
    : { capabilities: input.capabilities ?? [] };
}

function usd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

function describeEntry(entry: ChainEntry, position: number): string {
  const name = entry.displayName ?? entry.canonicalName;
  const price = entry.price.known
    ? `${usd(entry.price.inputUsdPerMTok ?? 0)} in / ${usd(entry.price.outputUsdPerMTok ?? 0)} out per 1M tokens`
    : "no price on record";
  const flag = entry.overCeiling ? " — over this bench's ceiling" : "";
  return `${position}. ${name} via ${entry.providerName} — ${price}${flag}`;
}

export function describeChain(chain: ModelChainResult): string {
  if (chain.entries.length === 0) {
    return (
      chain.note ?? "Nothing on this bench can do that kind of work right now."
    );
  }
  const lines = chain.entries.map((entry, index) =>
    describeEntry(entry, index + 1),
  );
  const head =
    chain.entries.length === 1
      ? "One model here fits:"
      : "Use the first; the rest are fallbacks, in order:";
  return [head, ...lines, chain.note].filter(Boolean).join("\n");
}

async function runListModelConcepts(
  env: WorkflowCatalogEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const concepts = await listConcepts(clientConfig(env));
    const lines = concepts.map((concept) => {
      const availability =
        concept.availableModels === 0
          ? "nothing here can do it yet"
          : `${concept.availableModels} model${concept.availableModels === 1 ? "" : "s"} here, best via ${concept.headProvider ?? "unknown"}`;
      return `${concept.id} — ${concept.whenToUse} (${availability})`;
    });
    return {
      callId: call.id,
      isError: false,
      content: [
        "Ask for a model by the kind of work, using one of these ids:",
        ...lines,
      ].join("\n"),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runPickModels(
  env: WorkflowCatalogEnv,
  call: ToolCall,
  parsed: PickModelsInput,
): Promise<ToolResult> {
  try {
    const need = needOf(parsed);
    const chain = await fetchChain(clientConfig(env), {
      concept: need.concept,
      capabilities: need.capabilities,
      order: parsed.order,
      limit: parsed.limit,
    });
    return { callId: call.id, isError: false, content: describeChain(chain) };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runEstimateRunCost(
  env: WorkflowCatalogEnv,
  call: ToolCall,
  parsed: EstimateRunCostInput,
): Promise<ToolResult> {
  try {
    const need = needOf(parsed);
    const estimate = await fetchEstimate(clientConfig(env), {
      concept: need.concept,
      capabilities: need.capabilities,
      expectedInputTokens: parsed.expectedInputTokens,
      expectedOutputTokens: parsed.expectedOutputTokens,
    });
    if (estimate.estimates.length === 0) {
      return {
        callId: call.id,
        isError: false,
        content: "Nothing on this bench can do that kind of work right now.",
      };
    }
    const lines = estimate.estimates.map((row) =>
      row.estimatedUsd === null
        ? `${row.canonicalName} via ${row.providerName} — no price on record, so no estimate`
        : `${row.canonicalName} via ${row.providerName} — about ${usd(row.estimatedUsd)}`,
    );
    return {
      callId: call.id,
      isError: false,
      content: ["That run would cost roughly:", ...lines].join("\n"),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/catalog-tools` bundle factory: three read-only tools, no
 * approval gate, three env keys.
 */
export const catalogTools = defineTool<WorkflowCatalogEnv>({
  id: "@corbits/catalog-tools/catalog",
  requires: ["hubCatalogUrl", "sidecarToken", "address"],
  definitions: [
    { name: LIST_MODEL_CONCEPTS_TOOL },
    { name: PICK_MODELS_TOOL },
    { name: ESTIMATE_RUN_COST_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: LIST_MODEL_CONCEPTS_TOOL,
        description:
          "see the kinds of work this workbench can pick a model for, " +
          "and how many models it currently has for each. Read-only; " +
          "call it before pick_models when unsure which kind of work " +
          "fits.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: PICK_MODELS_TOOL,
        description:
          "get the models this workbench can actually reach for a kind " +
          "of work, cheapest first, with fallbacks behind the first. " +
          "Never name a model — ask by what the work needs.",
        inputSchema: {
          type: "object",
          properties: {
            ...needProperties,
            order: {
              type: "string",
              enum: ["cheapest", "catalog"],
              description:
                'Default "cheapest". Use "catalog" to follow this ' +
                "workbench's own preferred order instead of price.",
            },
            limit: {
              type: "number",
              description: "How many models to return, 1-10. Default 5.",
            },
          },
        },
      },
      {
        name: ESTIMATE_RUN_COST_TOOL,
        description:
          "estimate what a run would cost on the models this workbench " +
          "would use for a kind of work. Answers honestly that a model " +
          "has no price on record rather than guessing one.",
        inputSchema: {
          type: "object",
          properties: {
            ...needProperties,
            expectedInputTokens: {
              type: "number",
              description: "Roughly how many tokens will be sent.",
            },
            expectedOutputTokens: {
              type: "number",
              description: "Roughly how many tokens will come back.",
            },
          },
          required: ["expectedInputTokens", "expectedOutputTokens"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case LIST_MODEL_CONCEPTS_TOOL:
          return runListModelConcepts(env, call);
        case PICK_MODELS_TOOL: {
          const parsed = PickModelsInput(call.arguments);
          if (parsed instanceof type.errors) {
            return Promise.resolve(
              errorResult(
                call.id,
                new Error(
                  `pick_models received invalid input: ${parsed.summary}`,
                ),
              ),
            );
          }
          return runPickModels(env, call, parsed);
        }
        case ESTIMATE_RUN_COST_TOOL: {
          const parsed = EstimateRunCostInput(call.arguments);
          if (parsed instanceof type.errors) {
            return Promise.resolve(
              errorResult(
                call.id,
                new Error(
                  `estimate_run_cost received invalid input: ${parsed.summary}`,
                ),
              ),
            );
          }
          return runEstimateRunCost(env, call, parsed);
        }
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/catalog-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
