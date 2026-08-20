// The planner's reply contract and its fail-closed validation. Myra's
// reply is untrusted model output — a trust boundary exactly like a
// request body — so it is parsed with arktype (`parseTaskSpec`) and
// then checked reference-by-reference against the inventory that was
// actually offered (`validateTaskSpecAgainstInventory`). Neither step
// trusts a partial match: a spec that parses but names one
// out-of-inventory reference is rejected whole, never trimmed down to
// its valid parts.
import { type } from "arktype";
import type { PlannerInventory } from "./inventory";

const MIN_CHAIN_STEPS = 2;
const MAX_CHAIN_STEPS = 5;

/** One step's agent choice, shared verbatim by a single `{kind: "task"}`
 * spec and every entry of a `{kind: "chain"}` spec's `steps` — the same
 * `{use}`/`{create}` shapes either way, each carrying its own
 * `refinedOutcome` so a chain's later steps are never left inferring
 * their prompt from the first step's. */
const UseStep = type({
  use: "string > 0",
  refinedOutcome: "string > 0",
});

const CreateStep = type({
  create: {
    name: "string > 0",
    systemPrompt: "string > 0",
    toolPackagePins: "string[]",
    skills: "string[]",
    "modelPreference?": "string",
  },
  refinedOutcome: "string > 0",
});

export const TaskStep = UseStep.or(CreateStep);
export type TaskStep = typeof TaskStep.infer;

export const TaskSpec = type({ kind: "'task'" })
  .and(UseStep)
  .or(type({ kind: "'task'" }).and(CreateStep))
  .or(
    type({
      kind: "'chain'",
      steps: TaskStep.array()
        .atLeastLength(MIN_CHAIN_STEPS)
        .atMostLength(MAX_CHAIN_STEPS),
    }),
  );
export type TaskSpec = typeof TaskSpec.infer;

const MAX_REPLY_EXCERPT = 400;

function excerpt(raw: string): string {
  return raw.length > MAX_REPLY_EXCERPT
    ? `${raw.slice(0, MAX_REPLY_EXCERPT)}…`
    : raw;
}

export class PlannerReplyUnparseableError extends Error {
  constructor(reason: string, raw: string) {
    super(
      `Myra's reply couldn't be read as a task plan: ${reason} ` +
        `(reply excerpt: ${excerpt(raw)})`,
    );
    this.name = "PlannerReplyUnparseableError";
  }
}

export class PlannerReferenceOutOfInventoryError extends Error {
  constructor(field: string, reference: string) {
    super(
      `Myra's plan named "${reference}" for "${field}", which was never ` +
        "offered in the inventory",
    );
    this.name = "PlannerReferenceOutOfInventoryError";
  }
}

/** Parses `raw` as a `TaskSpec`, throwing `PlannerReplyUnparseableError`
 * on malformed JSON or a shape that matches neither union branch. Never
 * partially trusts a near-miss — the model must reply with exactly one
 * of the two shapes, no prose, no markdown fences. */
export function parseTaskSpec(raw: string): TaskSpec {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PlannerReplyUnparseableError("not valid JSON", raw);
  }
  const parsed = TaskSpec(json);
  if (parsed instanceof type.errors) {
    throw new PlannerReplyUnparseableError(parsed.summary, raw);
  }
  return parsed;
}

function validateStepAgainstInventory(
  step: TaskStep,
  inventory: PlannerInventory,
): void {
  if ("use" in step) {
    if (!inventory.agents.some((agent) => agent.id === step.use)) {
      throw new PlannerReferenceOutOfInventoryError("use", step.use);
    }
    return;
  }

  const toolPackageNames = new Set(
    inventory.toolPackages.map((entry) => entry.name),
  );
  for (const pin of step.create.toolPackagePins) {
    if (!toolPackageNames.has(pin)) {
      throw new PlannerReferenceOutOfInventoryError(
        "create.toolPackagePins",
        pin,
      );
    }
  }

  const skillNames = new Set(inventory.skills.map((entry) => entry.name));
  for (const skill of step.create.skills) {
    if (!skillNames.has(skill)) {
      throw new PlannerReferenceOutOfInventoryError("create.skills", skill);
    }
  }

  if (step.create.modelPreference !== undefined) {
    const modelNames = new Set(
      inventory.models.map((entry) => entry.canonicalName),
    );
    if (!modelNames.has(step.create.modelPreference)) {
      throw new PlannerReferenceOutOfInventoryError(
        "create.modelPreference",
        step.create.modelPreference,
      );
    }
  }
}

/**
 * Asserts every reference a validated-shape `TaskSpec` makes actually
 * appears in `inventory` — the inventory that was actually offered to
 * Myra, not a copy fetched fresh afterward, so a race between offering
 * and validating can never widen what the plan is allowed to name.
 * Throws `PlannerReferenceOutOfInventoryError` on the first violation
 * found; checks every reference before returning, never trusting a
 * partially-valid plan — for a `{kind: "chain"}` spec, every step is
 * checked, in order, before any of them is trusted. No return value —
 * this is a pure assertion.
 */
export function validateTaskSpecAgainstInventory(
  spec: TaskSpec,
  inventory: PlannerInventory,
): void {
  if (spec.kind === "chain") {
    for (const step of spec.steps) {
      validateStepAgainstInventory(step, inventory);
    }
    return;
  }
  validateStepAgainstInventory(spec, inventory);
}
