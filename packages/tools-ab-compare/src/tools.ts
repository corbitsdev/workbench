import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

// ---------------------------------------------------------------------------
// ab_comparison_compose — assemble the persisted A/B comparison artifact.
//
// A deterministic workflow helper (no inference, no credentials). It reads the
// whole `{ from: "steps" }` tree and folds three things into ONE structured
// payload that the artifact renderer (`ComparisonView`) reads back verbatim:
//
//   - the variant configs  (steps.config.output.variants — label/provider/model)
//   - the variant outputs  (steps.execute.output — the text each variant wrote)
//   - the decision         (who won + why), from EITHER:
//       * steps.compare.output.reply — an LLM judge's strict JSON  → decidedBy "agent"
//       * steps.decision.output      — the human's pick payload    → decidedBy "human"
//
// Output is `JSON.stringify(ComparisonResult)`; the persist step writes it as
// the artifact `content`. Keeping the assembly here (not in the persist
// argMap) is what lets the saved artifact carry the actual variant content
// side by side, not just the ranking — and lets the same artifact serve both
// the agent-select and the human-in-the-loop workflows.
// ---------------------------------------------------------------------------

export const AB_COMPARISON_COMPOSE_DEFINITION: ToolDefinition = {
  name: "ab_comparison_compose",
  description:
    "Internal A/B-comparison workflow helper. Fold the variant configs, the variant outputs, and the ranking decision (agent judge or human pick) from the workflow step outputs into one structured comparison artifact payload.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

// Step ids both A/B workflows agree on. The compose tool reads the whole steps
// tree, so it must know where each piece lives.
const CONFIG_STEP = "config";
const EXECUTE_STEP = "execute";
const AGENT_DECISION_STEP = "compare";
const HUMAN_DECISION_STEP = "decision";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The workflow runtime passes the steps tree as the tool args. A tool-call
// transport that can't carry a nested object falls back to a `_raw` JSON
// string (mirrors the last30days helpers).
function coerceArgsObject(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args._raw === "string") {
    const parsed: unknown = JSON.parse(args._raw);
    if (!isRecord(parsed)) {
      throw new Error("_raw fallback is not a JSON object");
    }
    return parsed;
  }
  return args;
}

// Each step entry in the tree is `{ output: <stepOutput> }`.
function readStepOutput(steps: Record<string, unknown>, id: string): unknown {
  const step = steps[id];
  return isRecord(step) ? step.output : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const RankingEntry = type({
  rank: "number",
  label: "string",
  "rationale?": "string",
});
type RankingEntry = typeof RankingEntry.infer;

interface Decision {
  decidedBy: "agent" | "human";
  summary?: string;
  recommendation?: string;
  ranking: RankingEntry[];
}

// Keep only well-formed ranking rows; a malformed entry is dropped rather than
// poisoning the whole artifact.
function coerceRanking(value: unknown): RankingEntry[] {
  if (!Array.isArray(value)) return [];
  const rows: RankingEntry[] = [];
  for (const candidate of value) {
    const parsed = RankingEntry(candidate);
    if (!(parsed instanceof type.errors)) rows.push(parsed);
  }
  return rows;
}

function readDecisionObject(
  output: Record<string, unknown>,
  decidedBy: "agent" | "human",
): Decision {
  const ranking = coerceRanking(output.ranking);
  // A top-level `rationale` (the dock choice+prompt-box path, CL-2683) attaches
  // to the winner when the rank-1 row carries none, so a dock decision composes
  // the same artifact the run-page panel produces (which nests the rationale on
  // the winner row directly).
  const topRationale = readString(output.rationale);
  const winner = ranking.find((row) => row.rank === 1);
  if (topRationale !== undefined && winner !== undefined) {
    if (winner.rationale === undefined) winner.rationale = topRationale;
  }
  const decision: Decision = {
    decidedBy,
    ranking,
  };
  const summary = readString(output.summary);
  if (summary !== undefined) decision.summary = summary;
  const recommendation = readString(output.recommendation);
  if (recommendation !== undefined) decision.recommendation = recommendation;
  return decision;
}

// Prefer the human decision (HITL) when present; otherwise read the agent
// judge's strict-JSON reply (Agent Select). Either way produce a uniform
// Decision so the artifact shape is identical across both workflows.
function readDecision(steps: Record<string, unknown>): Decision {
  const human = readStepOutput(steps, HUMAN_DECISION_STEP);
  if (isRecord(human)) {
    return readDecisionObject(human, "human");
  }

  const agent = readStepOutput(steps, AGENT_DECISION_STEP);
  const reply = isRecord(agent) ? agent.reply : undefined;
  if (typeof reply === "string") {
    try {
      const parsed: unknown = JSON.parse(reply);
      if (isRecord(parsed)) return readDecisionObject(parsed, "agent");
    } catch {
      // A non-JSON judge reply degrades to an empty (agent) decision rather
      // than failing the run; the renderer still shows the variants.
    }
  }
  return { decidedBy: "agent", ranking: [] };
}

interface VariantConfig {
  label: string;
  providerName?: string;
  model?: string;
}

function readVariantConfigs(steps: Record<string, unknown>): VariantConfig[] {
  const config = readStepOutput(steps, CONFIG_STEP);
  const variants = isRecord(config) ? config.variants : undefined;
  if (!Array.isArray(variants)) return [];
  return variants.map((variant, index) => {
    const record = isRecord(variant) ? variant : {};
    const out: VariantConfig = {
      label: readString(record.label) ?? `Variant ${index + 1}`,
    };
    const providerName = readString(record.providerName);
    if (providerName !== undefined) out.providerName = providerName;
    const model = readString(record.model);
    if (model !== undefined) out.model = model;
    return out;
  });
}

// The execute map emits one inner output per variant, in config order. The
// inner output is `{ reply }`; tolerate an `{ output: { reply } }` wrapping too.
function readVariantReplies(steps: Record<string, unknown>): string[] {
  const execute = readStepOutput(steps, EXECUTE_STEP);
  if (!Array.isArray(execute)) return [];
  return execute.map((entry) => {
    if (isRecord(entry)) {
      const direct = readString(entry.reply);
      if (direct !== undefined) return direct;
      const nested = isRecord(entry.output)
        ? readString(entry.output.reply)
        : undefined;
      if (nested !== undefined) return nested;
    }
    return "";
  });
}

interface ComposedVariant {
  label: string;
  providerName?: string;
  model?: string;
  content: string;
}

export function composeComparisonResult(steps: Record<string, unknown>): {
  summary?: string;
  recommendation?: string;
  decidedBy: "agent" | "human";
  ranking: RankingEntry[];
  variants: ComposedVariant[];
} {
  const configs = readVariantConfigs(steps);
  const replies = readVariantReplies(steps);
  const decision = readDecision(steps);

  const variants: ComposedVariant[] = configs.map((config, index) => {
    const variant: ComposedVariant = {
      label: config.label,
      content: replies[index] ?? "",
    };
    if (config.providerName !== undefined) {
      variant.providerName = config.providerName;
    }
    if (config.model !== undefined) variant.model = config.model;
    return variant;
  });

  const result = {
    decidedBy: decision.decidedBy,
    ranking: decision.ranking,
    variants,
  } as {
    summary?: string;
    recommendation?: string;
    decidedBy: "agent" | "human";
    ranking: RankingEntry[];
    variants: ComposedVariant[];
  };
  if (decision.summary !== undefined) result.summary = decision.summary;
  if (decision.recommendation !== undefined) {
    result.recommendation = decision.recommendation;
  }
  return result;
}

function createComposeTool(): AgentTool {
  return {
    kind: "string",
    definition: AB_COMPARISON_COMPOSE_DEFINITION,
    handler: async (args) => {
      const steps = coerceArgsObject(args);
      return JSON.stringify(composeComparisonResult(steps));
    },
  };
}

/** The stateless A/B-comparison helper tools (no credential, no host context). */
export function createAbCompareTools(): AgentTool[] {
  return [createComposeTool()];
}
