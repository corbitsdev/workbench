import type { EvalDefinition, EvalStep } from "./types.ts";

export interface DefineEvalConfig {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly EvalStep[];
  readonly memorySeed?: readonly string[];
}

/** Validates and returns an `EvalDefinition` — a hardcoded expected
 * scenario, never generated or inferred. Fails loudly on an empty name
 * or an eval with no steps, rather than silently accepting a
 * definition that could never run or never grade anything. */
export function defineEval(config: DefineEvalConfig): EvalDefinition {
  if (config.name === "") {
    throw new Error("defineEval requires a non-empty name");
  }
  if (config.steps.length === 0) {
    throw new Error(`defineEval("${config.name}") requires at least one step`);
  }
  const steps = config.steps.map((step) =>
    step.kind === undefined ? { ...step, kind: "scripted" as const } : step,
  );
  if (config.memorySeed !== undefined) {
    return {
      name: config.name,
      description: config.description,
      steps,
      memorySeed: config.memorySeed,
    };
  }
  return {
    name: config.name,
    description: config.description,
    steps,
  };
}
