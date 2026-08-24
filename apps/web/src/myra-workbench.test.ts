import { describe, expect, test } from "bun:test";

import { findMyraDefinition } from "./myra-workbench";
import type { AgentDefinition } from "./agents-api";

function definition(partial: {
  readonly id: string;
  readonly name: string;
}): AgentDefinition {
  return {
    id: partial.id,
    tenantId: "tnt_1",
    name: partial.name,
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("findMyraDefinition", () => {
  test("matches the seeded assistant asset, not a display name", () => {
    const definitions = [
      definition({ id: "def-echo", name: "echo" }),
      definition({ id: "def-assistant", name: "assistant" }),
    ];
    expect(findMyraDefinition(definitions)?.id).toBe("def-assistant");
  });

  test("returns undefined when no assistant definition is deployed", () => {
    expect(
      findMyraDefinition([definition({ id: "def-echo", name: "echo" })]),
    ).toBeUndefined();
  });
});
