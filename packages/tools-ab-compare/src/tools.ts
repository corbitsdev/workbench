import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

// ---------------------------------------------------------------------------
// A/B-preset workflow helpers (deterministic — no inference, no credentials).
//
// The curated preset workflows fix N models at definition time and run each as
// its own `exec<i>` inline step (a `map` would collapse every variant onto one
// pinned source). The definition threads the fixed variant metadata in as a
// literal `__presetVariants` (blind `label` + real `model`), so these helpers
// read each `exec<i>` output rather than a `config`/`execute`-map tree.
//
// Two tools:
//   - `ab_preset_quorum`  — run after all variants, BEFORE the human decision:
//     throws (fails the run) if fewer than `AB_PRESET_QUORUM` variants produced
//     an answer, so the human is never shown a pick that cannot stand.
//   - `ab_preset_compose` — run after the decision: folds the fixed variant
//     metadata, each variant's output, and the human ranking into the one
//     `ComparisonResult` the renderer reads back.
// ---------------------------------------------------------------------------

/** Minimum variants that must produce an answer for the comparison to stand. */
export const AB_PRESET_QUORUM = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The workflow runtime passes the merged steps tree as the tool args. A
// tool-call transport that can't carry a nested object falls back to a `_raw`
// JSON string (mirrors the last30days helpers).
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

// The human decision (the `decision` gate payload). A top-level `rationale` (the
// dock choice+prompt-box path) attaches to the winner when the rank-1 row
// carries none, so the dock and the run-page panel produce equivalent artifacts.
function readDecision(steps: Record<string, unknown>): Decision {
  const output = readStepOutput(steps, "decision");
  if (!isRecord(output)) return { ranking: [] };
  const ranking = coerceRanking(output.ranking);
  const topRationale = readString(output.rationale);
  const winner = ranking.find((row) => row.rank === 1);
  if (topRationale !== undefined && winner !== undefined) {
    if (winner.rationale === undefined) winner.rationale = topRationale;
  }
  const decision: Decision = { ranking };
  const summary = readString(output.summary);
  if (summary !== undefined) decision.summary = summary;
  const recommendation = readString(output.recommendation);
  if (recommendation !== undefined) decision.recommendation = recommendation;
  return decision;
}

interface ComposedVariant {
  label: string;
  model?: string;
  content: string;
}

interface PresetVariantMeta {
  label: string;
  model: string;
}

function readPresetVariantMeta(
  args: Record<string, unknown>,
): PresetVariantMeta[] {
  const raw = args.__presetVariants;
  if (!Array.isArray(raw)) return [];
  const metas: PresetVariantMeta[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = isRecord(entry) ? entry : {};
    const model = readString(record.model);
    if (model === undefined) continue;
    metas.push({
      label: readString(record.label) ?? `Variant ${index + 1}`,
      model,
    });
  }
  return metas;
}

// Each variant ran as `exec<i>`; its output is `{ reply, isError?, error? }`. A
// non-fatal skip carries `isError: true` and an empty reply. An empty reply with
// no error is also treated as a non-answer (it cannot be compared or ranked) —
// a legitimately-empty completion is rare and would contribute nothing anyway.
function readPresetVariantOutput(
  args: Record<string, unknown>,
  index: number,
): { content: string; failed: boolean } {
  const step = args[`exec${index}`];
  const output = isRecord(step) ? step.output : undefined;
  if (!isRecord(output)) return { content: "", failed: true };
  const failed = output.isError === true;
  const content = readString(output.reply) ?? "";
  return { content, failed: failed || content.length === 0 };
}

// The fixed variants folded with each exec output, plus the survivor count. The
// single source of truth both the quorum gate and the compose step read.
export function readPresetVariants(args: Record<string, unknown>): {
  variants: ComposedVariant[];
  survived: number;
  total: number;
} {
  const metas = readPresetVariantMeta(args);
  const variants: ComposedVariant[] = [];
  let survived = 0;
  for (const [index, meta] of metas.entries()) {
    const { content, failed } = readPresetVariantOutput(args, index);
    if (!failed) survived += 1;
    variants.push({ label: meta.label, model: meta.model, content });
  }
  return { variants, survived, total: metas.length };
}

export const AB_PRESET_QUORUM_DEFINITION: ToolDefinition = {
  name: "ab_preset_quorum",
  description:
    "Internal A/B-preset workflow helper. Fail the run before the human decision when fewer than the required number of variants produced an answer, so a doomed comparison never reaches the winner-pick gate.",
  inputSchema: { type: "object", additionalProperties: true },
};

// Throws (fails the run) when too few variants answered. Runs AFTER every
// variant lane completes and BEFORE the decision gate.
export function enforcePresetQuorum(args: Record<string, unknown>): {
  survived: number;
  total: number;
} {
  const { survived, total } = readPresetVariants(args);
  if (survived < AB_PRESET_QUORUM) {
    throw new Error(
      `ab_preset_quorum: only ${survived} of ${total} models produced an answer; a comparison needs at least ${AB_PRESET_QUORUM}`,
    );
  }
  return { survived, total };
}

export const AB_PRESET_COMPOSE_DEFINITION: ToolDefinition = {
  name: "ab_preset_compose",
  description:
    "Internal A/B-preset workflow helper. Fold the fixed variant metadata, each variant's inline-step output, and the human ranking into one structured comparison artifact payload.",
  inputSchema: { type: "object", additionalProperties: true },
};

export function composePresetComparisonResult(args: Record<string, unknown>): {
  summary?: string;
  recommendation?: string;
  decidedBy: "human";
  ranking: RankingEntry[];
  variants: ComposedVariant[];
} {
  const { variants, survived, total } = readPresetVariants(args);

  // Defence in depth: the quorum gate already failed the run below quorum, so
  // reaching compose with too few survivors is a programming error, not a user
  // outcome. Fail loudly rather than persist a hollow comparison.
  if (survived < AB_PRESET_QUORUM) {
    throw new Error(
      `ab_preset_compose: only ${survived} of ${total} models produced an answer; a comparison needs at least ${AB_PRESET_QUORUM}`,
    );
  }

  // The human ranking is a /resume payload — validated for shape at the
  // boundary, but its labels are free strings. Keep only rows that name a real
  // variant so a forged/stale label (e.g. "Variant 9") cannot enter the artifact.
  const knownLabels = new Set(variants.map((v) => v.label));
  const decision = readDecision(args);
  const ranking = decision.ranking.filter((row) => knownLabels.has(row.label));
  const result = {
    decidedBy: "human" as const,
    ranking,
    variants,
  } as {
    summary?: string;
    recommendation?: string;
    decidedBy: "human";
    ranking: RankingEntry[];
    variants: ComposedVariant[];
  };
  if (decision.summary !== undefined) result.summary = decision.summary;
  if (decision.recommendation !== undefined) {
    result.recommendation = decision.recommendation;
  }
  return result;
}

function createPresetQuorumTool(): AgentTool {
  return {
    kind: "string",
    definition: AB_PRESET_QUORUM_DEFINITION,
    handler: async (args) => {
      return JSON.stringify(enforcePresetQuorum(coerceArgsObject(args)));
    },
  };
}

function createPresetComposeTool(): AgentTool {
  return {
    kind: "string",
    definition: AB_PRESET_COMPOSE_DEFINITION,
    handler: async (args) => {
      return JSON.stringify(
        composePresetComparisonResult(coerceArgsObject(args)),
      );
    },
  };
}

/** The stateless A/B-comparison helper tools (no credential, no host context). */
export function createAbCompareTools(): AgentTool[] {
  return [createPresetQuorumTool(), createPresetComposeTool()];
}

export const AB_COMPARE_TOOL_DEFINITIONS: ToolDefinition[] = [
  AB_PRESET_QUORUM_DEFINITION,
  AB_PRESET_COMPOSE_DEFINITION,
];
