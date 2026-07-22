import { describe, expect, test } from "bun:test";
import { ALL_EVAL_CASES } from "./fixtures";
import {
  EVAL_COMPOSE_BY_GENERATION,
  composePersonalAgentEvalPrompt,
  composePersonalAgentEvalPromptV2,
} from "./compose-prompt";

/**
 * CL-4138: prove every case in the corpus composes a valid, non-empty
 * provider-formatted system prompt under both prompt generations, so the
 * runner can drive the same case against v1 and v2 for comparison. This
 * file (not `fixtures.test.ts`/`runner.test.ts`) is the one eval-package
 * test that pulls the full personal-agent definition graph, matching the
 * existing `run-baseline.ts` boundary.
 */
describe("EVAL_COMPOSE_BY_GENERATION", () => {
  test("both generations are wired", () => {
    expect(EVAL_COMPOSE_BY_GENERATION.v1).toBe(composePersonalAgentEvalPrompt);
    expect(EVAL_COMPOSE_BY_GENERATION.v2).toBe(
      composePersonalAgentEvalPromptV2,
    );
  });

  test("every case composes a valid v1 prompt", () => {
    for (const caseDef of ALL_EVAL_CASES) {
      const prompt = composePersonalAgentEvalPrompt({ caseDef });
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain("Myra");
    }
  });

  test("every case composes a valid v2 prompt", () => {
    for (const caseDef of ALL_EVAL_CASES) {
      const prompt = composePersonalAgentEvalPromptV2({ caseDef });
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain("Myra");
    }
  });

  test("v1 and v2 prompts differ for the same case", () => {
    const caseDef = ALL_EVAL_CASES[0];
    if (caseDef === undefined) throw new Error("empty corpus");
    const v1Prompt = composePersonalAgentEvalPrompt({ caseDef });
    const v2Prompt = composePersonalAgentEvalPromptV2({ caseDef });
    expect(v1Prompt).not.toBe(v2Prompt);
  });

  test("a case with saved member instructions composes under both generations", () => {
    const caseDef = {
      id: "compose-prompt-test-member-instructions",
      title: "member instructions render",
      description: "synthetic case for the compose-prompt boundary test",
      userInput: "Just send this one to Jane only, don't CC anyone else.",
      context: {
        memberInstructions: "Always CC the whole team on outbound emails.",
      },
      constraints: {},
      tags: [],
    };
    for (const compose of Object.values(EVAL_COMPOSE_BY_GENERATION)) {
      const prompt = compose({ caseDef });
      expect(prompt).toContain("CC");
    }
  });
});
