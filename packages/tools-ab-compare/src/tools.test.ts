import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { abCompare } from "./interchange-tools";
import { composeComparisonResult, createAbCompareTools } from "./tools";

const env = {} as BaseEnv;

// A realistic steps tree: a config signal, an execute map output, and either a
// `compare` (agent judge) or a `decision` (human) step.
function stepsWithAgentJudge() {
  return {
    config: {
      output: {
        variants: [
          { label: "Variant 1", providerName: "anthropic", model: "claude" },
          { label: "Variant 2", providerName: "openai", model: "gpt" },
        ],
        input: "rewrite it",
      },
    },
    execute: {
      output: [{ reply: "Variant one body." }, { reply: "Variant two body." }],
    },
    compare: {
      output: {
        reply: JSON.stringify({
          summary: "V1 wins.",
          recommendation: "Ship V1.",
          ranking: [
            { rank: 1, label: "Variant 1", rationale: "Tighter." },
            { rank: 2, label: "Variant 2", rationale: "Wordier." },
          ],
        }),
      },
    },
  };
}

describe("tools-ab-compare interchange.tools entry", () => {
  test("exports a namespaced keyless tool factory", () => {
    expect(typeof abCompare).toBe("function");
    expect(abCompare.id).toBe("@workbench/tools-ab-compare/compose");
    expect(abCompare.requires).toEqual([]);
  });

  test("exposes the compose tool", () => {
    const bundle = abCompare(env);
    expect(bundle.definitions.map((d) => d.name)).toEqual([
      "ab_comparison_compose",
    ]);
  });
});

describe("composeComparisonResult", () => {
  test("folds config, execute, and an agent judge into one payload", () => {
    const result = composeComparisonResult(stepsWithAgentJudge());
    expect(result.decidedBy).toBe("agent");
    expect(result.summary).toBe("V1 wins.");
    expect(result.recommendation).toBe("Ship V1.");
    expect(result.ranking).toHaveLength(2);
    // Variant content is carried side by side with the ranking.
    expect(result.variants).toEqual([
      {
        label: "Variant 1",
        providerName: "anthropic",
        model: "claude",
        content: "Variant one body.",
      },
      {
        label: "Variant 2",
        providerName: "openai",
        model: "gpt",
        content: "Variant two body.",
      },
    ]);
  });

  test("reads a human decision when a decision step is present (HITL)", () => {
    const steps = {
      ...stepsWithAgentJudge(),
      // The human's pick supersedes any agent judge.
      decision: {
        output: {
          summary: "Reviewer preferred V2.",
          ranking: [
            { rank: 1, label: "Variant 2", rationale: "Better close." },
            { rank: 2, label: "Variant 1" },
          ],
        },
      },
    };
    const result = composeComparisonResult(steps);
    expect(result.decidedBy).toBe("human");
    expect(result.ranking[0]?.label).toBe("Variant 2");
    // Variant content still comes from execute, in config order.
    expect(result.variants[1]?.content).toBe("Variant two body.");
  });

  test("degrades to an empty ranking on a non-JSON judge reply", () => {
    const steps = {
      ...stepsWithAgentJudge(),
      compare: { output: { reply: "not json at all" } },
    };
    const result = composeComparisonResult(steps);
    expect(result.ranking).toEqual([]);
    // Variants are still assembled so the renderer shows the outputs.
    expect(result.variants).toHaveLength(2);
  });

  test("drops malformed ranking rows but keeps valid ones", () => {
    const steps = {
      ...stepsWithAgentJudge(),
      compare: {
        output: {
          reply: JSON.stringify({
            ranking: [
              { rank: 1, label: "Variant 1" },
              { rank: "nope", label: "Variant 2" },
              { label: "missing rank" },
            ],
          }),
        },
      },
    };
    const result = composeComparisonResult(steps);
    expect(result.ranking).toEqual([{ rank: 1, label: "Variant 1" }]);
  });

  test("falls back to positional labels and blank content when steps are thin", () => {
    const steps = {
      config: { output: { variants: [{}, {}] } },
      execute: { output: [{ reply: "only one" }] },
    };
    const result = composeComparisonResult(steps);
    expect(result.variants.map((v) => v.label)).toEqual([
      "Variant 1",
      "Variant 2",
    ]);
    expect(result.variants[0]?.content).toBe("only one");
    expect(result.variants[1]?.content).toBe("");
    expect(result.decidedBy).toBe("agent");
    expect(result.ranking).toEqual([]);
  });

  test("compose tool handler returns a JSON string that round-trips", async () => {
    const tools = createAbCompareTools();
    const compose = tools.find(
      (t) => t.definition.name === "ab_comparison_compose",
    );
    if (compose?.kind !== "string") throw new Error("expected a string tool");
    const out = await compose.handler(
      stepsWithAgentJudge(),
      AbortSignal.timeout(1000),
    );
    expect(typeof out).toBe("string");
    expect(JSON.parse(out).variants).toHaveLength(2);
  });
});
