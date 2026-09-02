import { describe, expect, test } from "bun:test";

import type { ScorerContext, WorldSnapshot } from "../types.ts";
import {
  agentHasTools,
  connectionIsLive,
  fakeReceived,
  routineDeliversTo,
  routineHasTrigger,
} from "./world-scorers.ts";

function worldCtx(world: Partial<WorldSnapshot>): ScorerContext {
  return {
    transcript: [],
    turnIndex: 0,
    world: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      agentDefinitions: [],
      routines: [],
      connections: [],
      webhookTriggers: [],
      fakeReceipts: [],
      ...world,
    },
  };
}

describe("agentHasTools", () => {
  test("passes when the named agent has every tool pinned", () => {
    const ctx = worldCtx({
      agentDefinitions: [
        {
          id: "def-1",
          name: "AI Daily researcher",
          displayName: null,
          toolPackagePins: [
            "@corbits/web-search-tools",
            "@corbits/memory-tools",
          ],
          skills: [],
          model: null,
        },
      ],
    });
    const r = agentHasTools("AI Daily researcher", [
      "@corbits/web-search-tools",
    ])(ctx);
    expect(r.pass).toBe(true);
  });

  test("fails when the agent is missing a required tool", () => {
    const ctx = worldCtx({
      agentDefinitions: [
        {
          id: "def-1",
          name: "AI Daily researcher",
          displayName: null,
          toolPackagePins: ["@corbits/memory-tools"],
          skills: [],
          model: null,
        },
      ],
    });
    const r = agentHasTools("AI Daily researcher", [
      "@corbits/web-search-tools",
    ])(ctx);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("@corbits/web-search-tools");
  });

  test("fails when the agent doesn't exist yet", () => {
    const r = agentHasTools("Nobody", ["x"])(worldCtx({}));
    expect(r.pass).toBe(false);
  });
});

describe("routineHasTrigger", () => {
  test("passes when the named routine's trigger.kind matches", () => {
    const ctx = worldCtx({
      routines: [
        {
          id: "r-1",
          name: "Daily digest",
          definitionAssetId: "def-1",
          trigger: { kind: "daily", time: "09:00" },
          deliveryWorkbenchId: "wb-1",
          enabled: true,
        },
      ],
    });
    const r = routineHasTrigger("Daily digest", "daily")(ctx);
    expect(r.pass).toBe(true);
  });

  test("fails when trigger.kind doesn't match", () => {
    const ctx = worldCtx({
      routines: [
        {
          id: "r-1",
          name: "Daily digest",
          definitionAssetId: "def-1",
          trigger: { kind: "weekly" },
          deliveryWorkbenchId: null,
          enabled: true,
        },
      ],
    });
    const r = routineHasTrigger("Daily digest", "daily")(ctx);
    expect(r.pass).toBe(false);
  });

  test("fails when the routine doesn't exist yet", () => {
    const r = routineHasTrigger("Nothing yet", "daily")(worldCtx({}));
    expect(r.pass).toBe(false);
  });
});

describe("routineDeliversTo", () => {
  test("passes when deliveryWorkbenchId matches", () => {
    const ctx = worldCtx({
      routines: [
        {
          id: "r-1",
          name: "Daily digest",
          definitionAssetId: "def-1",
          trigger: null,
          deliveryWorkbenchId: "wb-1",
          enabled: true,
        },
      ],
    });
    expect(routineDeliversTo("Daily digest", "wb-1")(ctx).pass).toBe(true);
    expect(routineDeliversTo("Daily digest", "wb-2")(ctx).pass).toBe(false);
  });
});

describe("connectionIsLive", () => {
  test("passes for a live connection, fails for none found", () => {
    const ctx = worldCtx({
      connections: [
        { slug: "github", name: "GitHub", url: "https://x", live: true },
      ],
    });
    expect(connectionIsLive("github")(ctx).pass).toBe(true);
    expect(connectionIsLive("attio")(ctx).pass).toBe(false);
  });

  test("fails for a connection that exists but isn't live", () => {
    const ctx = worldCtx({
      connections: [
        { slug: "github", name: "GitHub", url: "https://x", live: false },
      ],
    });
    expect(connectionIsLive("github")(ctx).pass).toBe(false);
  });
});

describe("fakeReceived", () => {
  test("passes once a matching call was received", () => {
    const ctx = worldCtx({
      fakeReceipts: [
        {
          server: "github",
          toolName: "list_pull_requests",
          arguments: { repo: "corbitsdev/workbench" },
        },
      ],
    });
    expect(fakeReceived("github", "list_pull_requests")(ctx).pass).toBe(true);
    expect(fakeReceived("github", "create_issue")(ctx).pass).toBe(false);
  });

  test("applies the optional argument matcher", () => {
    const ctx = worldCtx({
      fakeReceipts: [
        {
          server: "github",
          toolName: "create_issue",
          arguments: { repo: "a" },
        },
      ],
    });
    expect(
      fakeReceived(
        "github",
        "create_issue",
        (args) => args["repo"] === "b",
      )(ctx).pass,
    ).toBe(false);
    expect(
      fakeReceived(
        "github",
        "create_issue",
        (args) => args["repo"] === "a",
      )(ctx).pass,
    ).toBe(true);
  });
});
