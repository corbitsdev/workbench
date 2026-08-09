import { describe, expect, test } from "bun:test";

import { purposeDefinitions } from "../src/purpose-definitions";

describe("purposeDefinitions", () => {
  test("keeps only automatable catalog workflows", () => {
    const kept = purposeDefinitions([
      { id: "1", name: "channel-digest" },
      { id: "2", name: "heartbeat" },
      { id: "3", name: "echo" },
      { id: "4", name: "assistant" },
      { id: "5", name: "my-agent-handle" },
    ]);
    expect(kept.map((d) => d.name)).toEqual(["channel-digest", "heartbeat"]);
  });

  test("drops channel-host definition names even if they look catalog-like", () => {
    // isChannelHostDefinitionName owns the host naming contract; anything
    // it flags is out regardless of catalog membership.
    const kept = purposeDefinitions([
      { id: "1", name: "channel-digest" },
      { id: "2", name: "channel-host-xyz" },
    ]);
    expect(kept.map((d) => d.name)).toEqual(["channel-digest"]);
  });
});
