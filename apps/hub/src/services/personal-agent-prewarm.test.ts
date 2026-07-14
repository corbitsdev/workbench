import { afterEach, describe, expect, it, mock } from "bun:test";

// ─── @intx/* and cross-module boundary mocks ──────────────────────────
//
// relaunchInstanceIfNeeded owns the real launch (coalescer, dedup breaker,
// sidecar call); the prewarm sweep only selects candidates and drives it under
// bounded concurrency, so the sweep's own behavior is what we exercise here.
// The stub is swapped per-test via `relaunchImpl`.
let relaunchImpl: (instanceId: string) => Promise<void> = () =>
  Promise.resolve();
const relaunchInstanceIfNeeded = mock(
  (
    _db: unknown,
    _sessionService: unknown,
    _grantStore: unknown,
    _eventCollectors: unknown,
    instanceId: string,
  ) => relaunchImpl(instanceId),
);

mock.module("./agent-provisioning", () => ({
  relaunchInstanceIfNeeded,
}));

const {
  prewarmPersonalAgents,
  registerPersonalAgentPrewarm,
  personalTemplateKeys,
  MAX_PREWARM_CONCURRENCY,
} = await import("./personal-agent-prewarm");

// ─── Fakes ────────────────────────────────────────────────────────────

type Row = { instanceId: string; address: string };

// A drizzle select chain that resolves to `rows` regardless of the where clause.
// The window/templateKey filtering is delegated to SQL (like the wedge sweep's
// status filter), so these fakes model the DB's post-filter result set.
function makeDb(rows: Row[]) {
  const chain = {
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock(() => Promise.resolve(rows)),
  };
  return {
    db: { select: mock(() => chain) },
    selectChain: chain,
  };
}

function makeRouter(routable: string[] = []) {
  return {
    getRoutableAddresses: mock(() => routable),
    events: { on: () => () => {} },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MYRA_KEYS = ["myra"];

function run(
  db: unknown,
  router: unknown,
  opts: Parameters<typeof prewarmPersonalAgents>[5],
) {
  return prewarmPersonalAgents(
    db as never,
    router as never,
    {} as never,
    {} as never,
    {} as never,
    opts,
  );
}

afterEach(() => {
  relaunchInstanceIfNeeded.mockClear();
  relaunchImpl = () => Promise.resolve();
});

// ─── personalTemplateKeys (policy) ────────────────────────────────────

describe("personalTemplateKeys", () => {
  it("selects the personal-kind templates (Myra) and excludes shared agents", () => {
    const keys = personalTemplateKeys();
    expect(keys).toContain("myra");
    // Shared/sub-agents (e.g. Oat) are not personal and must never be prewarmed
    // as personal instances.
    expect(keys).not.toContain("oat");
    expect(keys.length).toBeGreaterThan(0);
  });
});

// ─── prewarmPersonalAgents ────────────────────────────────────────────

describe("prewarmPersonalAgents", () => {
  it("launches every unroutable personal instance the query returns", async () => {
    const { db } = makeDb([
      { instanceId: "ins-1", address: "a1@t.localhost" },
      { instanceId: "ins-2", address: "a2@t.localhost" },
    ]);
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS });

    const launched = relaunchInstanceIfNeeded.mock.calls.map((c) => c[4]);
    expect(launched.sort()).toEqual(["ins-1", "ins-2"]);
  });

  it("skips instances whose address is already routable", async () => {
    const { db } = makeDb([
      { instanceId: "ins-live", address: "live@t.localhost" },
      { instanceId: "ins-cold", address: "cold@t.localhost" },
    ]);
    await run(db, makeRouter(["live@t.localhost"]), {
      templateKeys: MYRA_KEYS,
    });

    const launched = relaunchInstanceIfNeeded.mock.calls.map((c) => c[4]);
    expect(launched).toEqual(["ins-cold"]);
  });

  it("does nothing and issues no query when no personal templates are configured", async () => {
    const { db } = makeDb([{ instanceId: "ins-1", address: "a1@t.localhost" }]);
    await run(db, makeRouter([]), { templateKeys: [] });

    expect(db.select).not.toHaveBeenCalled();
    expect(relaunchInstanceIfNeeded).not.toHaveBeenCalled();
  });

  it("dedups repeated instance ids so a launch fires at most once per instance", async () => {
    const { db } = makeDb([
      { instanceId: "ins-1", address: "a1@t.localhost" },
      { instanceId: "ins-1", address: "a1@t.localhost" },
    ]);
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS });

    expect(relaunchInstanceIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("never runs more launches in parallel than the concurrency limit", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      instanceId: `ins-${i}`,
      address: `a${i}@t.localhost`,
    }));
    const { db } = makeDb(rows);

    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    relaunchImpl = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred();
      gates.push(() => {
        inFlight -= 1;
        d.resolve();
      });
      return d.promise;
    };

    let done = false;
    const sweep = run(db, makeRouter([]), {
      templateKeys: MYRA_KEYS,
      concurrency: 2,
    }).then(() => {
      done = true;
    });
    // Drain the queue: release gates as they open until the sweep settles.
    while (!done) {
      const release = gates.shift();
      if (release) release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await sweep;

    expect(maxInFlight).toBe(2);
    expect(relaunchInstanceIfNeeded).toHaveBeenCalledTimes(6);
  });

  it("clamps concurrency to the documented maximum", async () => {
    const rows = Array.from(
      { length: MAX_PREWARM_CONCURRENCY + 3 },
      (_, i) => ({
        instanceId: `ins-${i}`,
        address: `a${i}@t.localhost`,
      }),
    );
    const { db } = makeDb(rows);

    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    relaunchImpl = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred();
      gates.push(() => {
        inFlight -= 1;
        d.resolve();
      });
      return d.promise;
    };

    let done = false;
    const sweep = run(db, makeRouter([]), {
      templateKeys: MYRA_KEYS,
      concurrency: MAX_PREWARM_CONCURRENCY + 100,
    }).then(() => {
      done = true;
    });
    while (!done) {
      const release = gates.shift();
      if (release) release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await sweep;

    expect(maxInFlight).toBe(MAX_PREWARM_CONCURRENCY);
  });

  it("isolates a single instance's launch failure and retries it on the next sweep", async () => {
    const { db } = makeDb([
      { instanceId: "ins-bad", address: "bad@t.localhost" },
      { instanceId: "ins-good", address: "good@t.localhost" },
    ]);

    relaunchImpl = (instanceId) =>
      instanceId === "ins-bad"
        ? Promise.reject(new Error("sidecar down"))
        : Promise.resolve();

    // A failing launch must not abort the sibling or reject the sweep.
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS });
    const firstPass = relaunchInstanceIfNeeded.mock.calls.map((c) => c[4]);
    expect(firstPass).toContain("ins-good");
    expect(firstPass).toContain("ins-bad");

    // Next sweep re-attempts the still-cold instance (no permanent give-up).
    relaunchInstanceIfNeeded.mockClear();
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS });
    expect(relaunchInstanceIfNeeded.mock.calls.map((c) => c[4])).toContain(
      "ins-bad",
    );
  });
});

// ─── registerPersonalAgentPrewarm (interval owner) ────────────────────

describe("registerPersonalAgentPrewarm", () => {
  it("does not overlap ticks while a slow sweep is still running", async () => {
    const { db } = makeDb([{ instanceId: "ins-1", address: "a1@t.localhost" }]);
    const gate = deferred();
    relaunchImpl = () => gate.promise;

    const stop = registerPersonalAgentPrewarm({
      db: db as never,
      router: makeRouter([]) as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      intervalMs: 1,
    });

    await new Promise((r) => setTimeout(r, 20));
    const callsWhileBusy = relaunchInstanceIfNeeded.mock.calls.length;
    // The first tick is still awaiting the gated launch; the reentrancy flag
    // must have suppressed every subsequent tick.
    expect(callsWhileBusy).toBe(1);

    gate.resolve();
    stop();
  });
});
