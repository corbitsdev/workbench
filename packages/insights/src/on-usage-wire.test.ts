import { describe, expect, test } from "bun:test";

import { createUsageSink } from "./collector";
import { createMemoryUsageStore } from "./store";

/**
 * Exact `UsageForwarded` payload the vendored event-collector emits
 * (`vendor/intx/hub-sessions/src/event-collector.ts` `UsageForwarded`).
 * Hub `onUsage` (`apps/hub/src/index.ts` ~572) remaps it to `UsageEvent` as:
 *   `{ turnId, tenantId, sessionId, model, tokens: usage.usage }`
 */
type HubUsageForwarded = {
  turnId: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  };
};

function hubOnUsageHandleArg(
  tenantId: string,
  sessionId: string,
  usage: HubUsageForwarded,
) {
  return {
    turnId: usage.turnId,
    tenantId,
    sessionId,
    model: usage.model,
    tokens: usage.usage,
  };
}

describe("hub onUsage wire → createUsageSink", () => {
  test("inserts a row from the exact hub remapping of UsageForwarded", async () => {
    const store = createMemoryUsageStore();
    let n = 0;
    const sink = createUsageSink({
      store,
      generateId: () => `id-${++n}`,
    });

    const forwarded: HubUsageForwarded = {
      turnId: "turn-wire-1",
      model: "claude-sonnet",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        thinking: 20,
      },
    };

    const status = await sink.handle(
      hubOnUsageHandleArg("tenant-acme", "session-1", forwarded),
    );

    expect(status).toBe("inserted");
    const rows = await store.listUsageByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnId).toBe("turn-wire-1");
    expect(rows[0]?.tenantId).toBe("tenant-acme");
    expect(rows[0]?.sessionId).toBe("session-1");
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
