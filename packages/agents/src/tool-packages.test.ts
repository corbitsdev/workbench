import { describe, expect, test } from "bun:test";
import { AGENT_TEMPLATES } from "./templates";

describe("tool-package pins", () => {
  test("Larry is no longer seeded as an idling agent template", () => {
    const larry = AGENT_TEMPLATES.find((t) => t.name === "Larry");
    expect(larry).toBeUndefined();
  });

  test("Loop and unknown agents have no tool packages", () => {
    const loop = AGENT_TEMPLATES.find((t) => t.name === "Loop");
    expect(loop?.toolPackages ?? []).toEqual([]);
    const unknown = AGENT_TEMPLATES.find((t) => t.name === "does-not-exist");
    expect(unknown).toBeUndefined();
  });
});
