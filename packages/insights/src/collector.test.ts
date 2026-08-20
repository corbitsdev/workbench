import { describe, expect, test } from "bun:test";

import { createUsageSink } from "./collector";
import { createMemoryUsageStore } from "./store";

describe("createUsageSink", () => {
  test("inserts a usage event", async () => {
    const store = createMemoryUsageStore();
    let n = 0;
    const sink = createUsageSink({
      store,
      generateId: () => `id-${++n}`,
    });

    const status = await sink.handle({
      turnId: "turn-1",
      tenantId: "tenant-acme",
      sessionId: "session-1",
      provider: "anthropic",
      model: "claude-sonnet",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 50,
        thinking: 0,
      },
      reportedCostUsd: 0.00125,
    });

    expect(status).toBe("inserted");
    const rows = await store.listUsageByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnId).toBe("turn-1");
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.tokens.input).toBe(100);
    expect(rows[0]?.reportedCostUsd).toBe(0.00125);
  });

  test("duplicate turnId is a no-op (restart-safe)", async () => {
    const store = createMemoryUsageStore();
    let n = 0;
    const sink = createUsageSink({
      store,
      generateId: () => `id-${++n}`,
    });

    const event = {
      turnId: "turn-dup",
      tenantId: "tenant-acme",
      sessionId: "session-1",
      model: "claude-sonnet",
      tokens: {
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 5,
        thinking: 0,
      },
    };

    expect(await sink.handle(event)).toBe("inserted");
    expect(await sink.handle(event)).toBe("duplicate");
    const rows = await store.listUsageByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(1);
  });
});
