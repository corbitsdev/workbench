import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { abCompare } from "./interchange-tools";
import {
  AB_PRESET_QUORUM,
  composePresetComparisonResult,
  createAbCompareTools,
  enforcePresetQuorum,
  readPresetVariants,
} from "./tools";

const env = {} as BaseEnv;

// The merged steps tree the preset compose/quorum steps receive: the fixed
// variant metadata as a literal `__presetVariants`, each variant's `exec<i>`
// output, and (for compose) the human `decision` step output.
function args(overrides: Record<string, unknown> = {}) {
  return {
    __presetVariants: [
      { label: "Variant 1", model: "claude-opus-4-8" },
      { label: "Variant 2", model: "gpt-5.5" },
      { label: "Variant 3", model: "glm-5.2" },
    ],
    exec0: { output: { reply: "opus answer" } },
    exec1: { output: { reply: "gpt answer" } },
    exec2: { output: { reply: "glm answer" } },
    ...overrides,
  };
}

describe("readPresetVariants", () => {
  test("folds each exec output against the fixed metadata and counts survivors", () => {
    const { variants, survived, total } = readPresetVariants(
      args({
        exec1: { output: { reply: "", isError: true, error: "503" } },
      }),
    );
    expect(total).toBe(3);
    expect(survived).toBe(2);
    expect(variants.map((v) => v.content)).toEqual([
      "opus answer",
      "",
      "glm answer",
    ]);
    // The failed variant still carries its blind label + model for the artifact.
    expect(variants[1]).toEqual({
      label: "Variant 2",
      model: "gpt-5.5",
      content: "",
    });
  });
});

describe("enforcePresetQuorum", () => {
  test("passes when at least the quorum of variants answered", () => {
    expect(enforcePresetQuorum(args())).toEqual({ survived: 3, total: 3 });
  });

  test("throws (fails the run) when fewer than the quorum answered", () => {
    expect(() =>
      enforcePresetQuorum(
        args({
          exec1: { output: { reply: "", isError: true } },
          exec2: { output: { reply: "", isError: true } },
        }),
      ),
    ).toThrow(new RegExp(`at least ${AB_PRESET_QUORUM}`));
  });
});

describe("composePresetComparisonResult", () => {
  test("folds survivors + the human ranking into the comparison result", () => {
    const result = composePresetComparisonResult(
      args({
        decision: { output: { ranking: [{ rank: 1, label: "Variant 2" }] } },
      }),
    );
    expect(result.decidedBy).toBe("human");
    expect(result.variants).toHaveLength(3);
    expect(result.ranking).toEqual([{ rank: 1, label: "Variant 2" }]);
  });

  test("carries a failed variant (empty content) when the quorum still holds", () => {
    const result = composePresetComparisonResult(
      args({
        exec2: { output: { reply: "", isError: true, error: "503" } },
        decision: { output: { ranking: [{ rank: 1, label: "Variant 1" }] } },
      }),
    );
    expect(result.variants).toHaveLength(3);
    expect(result.variants[2]?.content).toBe("");
  });

  test("folds a top-level rationale onto the winning row", () => {
    const result = composePresetComparisonResult(
      args({
        decision: {
          output: {
            ranking: [{ rank: 1, label: "Variant 3" }],
            rationale: "clearest answer",
          },
        },
      }),
    );
    const winner = result.ranking.find((r) => r.rank === 1);
    expect(winner?.rationale).toBe("clearest answer");
  });

  test("defensively throws below quorum (the gate should have failed first)", () => {
    expect(() =>
      composePresetComparisonResult(
        args({
          exec1: { output: { reply: "", isError: true } },
          exec2: { output: { reply: "", isError: true } },
          decision: { output: { ranking: [] } },
        }),
      ),
    ).toThrow(/at least 2/);
  });
});

describe("interchange.tools entry", () => {
  test("exposes the preset quorum + compose tools", () => {
    const bundle = abCompare(env);
    expect(bundle.definitions.map((d) => d.name)).toEqual([
      "ab_preset_quorum",
      "ab_preset_compose",
    ]);
  });

  test("both tools are stateless (constructed without env or host context)", () => {
    expect(createAbCompareTools().map((t) => t.definition.name)).toEqual([
      "ab_preset_quorum",
      "ab_preset_compose",
    ]);
  });
});
