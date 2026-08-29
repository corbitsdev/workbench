import { describe, expect, test } from "bun:test";

import { createUsageSink } from "./collector";
import { createMemoryUsageStore } from "./store";

/**
 * Exact `TurnUsage` payload `@intx/hub-sessions`' event collector emits once
 * per finalized turn. Hub `onUsage` (`apps/hub/src/index.ts`) remaps it to
 * `UsageEvent` as
 *   `{ turnId, tenantId, sessionId, provider, model, tokens: usage.usage }`
 */
type HubTurnUsage = {
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  };
};

function hubOnUsageHandleArg(usage: HubTurnUsage) {
  return {
    turnId: usage.turnId,
    tenantId: usage.tenantId,
    sessionId: usage.sessionId,
    provider: usage.provider,
    model: usage.model,
    tokens: usage.usage,
  };
}

describe("hub onUsage wire → createUsageSink", () => {
  test("inserts a row from the exact hub remapping of TurnUsage", async () => {
    const store = createMemoryUsageStore();
    let n = 0;
    const sink = createUsageSink({
      store,
      generateId: () => `id-${++n}`,
    });

    const forwarded: HubTurnUsage = {
      tenantId: "tenant-acme",
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-wire-1",
      provider: "anthropic",
      model: "claude-sonnet",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        thinking: 20,
      },
    };

    const status = await sink.handle(hubOnUsageHandleArg(forwarded));

    expect(status).toBe("inserted");
    const rows = await store.listUsageByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnId).toBe("turn-wire-1");
    expect(rows[0]?.tenantId).toBe("tenant-acme");
    expect(rows[0]?.sessionId).toBe("session-1");
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model).toBe("claude-sonnet");
    expect(rows[0]?.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      thinking: 20,
    });
  });
});
