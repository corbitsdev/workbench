import { describe, expect, test } from "bun:test";

import {
  createLocalRoutineDrafting,
  proposedNameFromPrompt,
  proposedStepsFromPrompt,
} from "./local-routine-drafting";

describe("proposedStepsFromPrompt", () => {
  test("always returns at least one step for empty input", () => {
    const steps = proposedStepsFromPrompt("   ");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]?.title.length).toBeGreaterThan(0);
  });

  test("splits bullet lines into steps", () => {
    const steps = proposedStepsFromPrompt(
      "Daily digest\n- Collect messages\n- Write summary\n- Post to #ops",
    );
    expect(steps.map((s) => s.title)).toEqual([
      "Daily digest",
      "Collect messages",
      "Write summary",
      "Post to #ops",
    ]);
  });

  test("splits numbered lines into steps", () => {
    const steps = proposedStepsFromPrompt(
      "1. Pull signups\n2. Summarize\n3. Deliver",
    );
    expect(steps.map((s) => s.title)).toEqual([
      "Pull signups",
      "Summarize",
      "Deliver",
    ]);
  });

  test("splits sentences when there are no bullets", () => {
    const steps = proposedStepsFromPrompt(
      "Pull the signups export. Summarize the day. Post to #ops.",
    );
    expect(steps).toHaveLength(3);
    expect(steps[0]?.title).toBe("Pull the signups export");
    expect(steps[2]?.title).toBe("Post to #ops");
  });

  test("single line becomes a single step", () => {
    const steps = proposedStepsFromPrompt("Run the morning brief");
    expect(steps).toEqual([{ title: "Run the morning brief" }]);
  });
});

describe("proposedNameFromPrompt", () => {
  test("uses the first line as a name", () => {
    expect(proposedNameFromPrompt("Morning brief\n- step one")).toBe(
      "Morning brief",
    );
  });

  test("returns undefined for blank input", () => {
    expect(proposedNameFromPrompt("  \n  ")).toBeUndefined();
  });
});

describe("createLocalRoutineDrafting", () => {
  test("propose returns non-empty steps and optional name", async () => {
    const port = createLocalRoutineDrafting();
    const result = await port.propose({
      tenantId: "t1",
      principalId: "u1",
      prompt: "Weekly report\n- Gather metrics\n- Write memo",
    });
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.name).toBe("Weekly report");
    expect(result.steps.map((s) => s.title)).toContain("Gather metrics");
    expect(result.definitionId).toBeUndefined();
  });

  test("sets definitionId when resolveDefinitionId auto-pins the sole definition", async () => {
    const port = createLocalRoutineDrafting({
      resolveDefinitionId: async (tenantId) => {
        expect(tenantId).toBe("t1");
        // Host pin: exactly one definition for the tenant.
        return "wfd_only";
      },
    });
    const result = await port.propose({
      tenantId: "t1",
      principalId: "u1",
      prompt: "Do the thing",
    });
    expect(result.definitionId).toBe("wfd_only");
  });

  test("leaves definitionId unset when resolveDefinitionId returns null (0 or multi-def)", async () => {
    const port = createLocalRoutineDrafting({
      // Host returns null for zero or multiple definitions — no fake pick.
      resolveDefinitionId: async () => null,
    });
    const result = await port.propose({
      tenantId: "t1",
      principalId: "u1",
      prompt: "Do the thing",
    });
    expect(result.definitionId).toBeUndefined();
  });
});
