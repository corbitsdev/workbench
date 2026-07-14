import { afterEach, describe, expect, it, mock } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SessionLaunchError } from "@intx/hub-sessions";

// ─── Module-boundary mock ─────────────────────────────────────────────
//
// relaunchInstanceIfNeeded owns the real launch (coalescer, dedup breaker,
// sidecar call); the prewarm sweep only selects candidates and drives it under
// bounded concurrency, so the sweep's own behavior is what we exercise here.
// The stub is swapped per-test via `relaunchImpl`. WEDGE_RELAUNCHABLE_STATUSES
// is re-exported verbatim because the sweep's selection predicate consumes it.
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
  WEDGE_RELAUNCHABLE_STATUSES: ["running", "deployed", "updating"] as const,
}));

const {
  prewarmPersonalAgents,
  createPersonalAgentPrewarmTick,
  registerPersonalAgentPrewarm,
  personalTemplateKeys,
  isSidecarUnavailableLaunchError,
} = await import("./personal-agent-prewarm");

// ─── Fakes ────────────────────────────────────────────────────────────

type Row = { instanceId: string; address: string };

// A drizzle select chain that resolves to `rows` and captures the predicate
// handed to `.where` so tests can render and inspect the composed SQL.
function makeDb(rows: Row[]) {
  const captured: { where: SQL | undefined } = { where: undefined };
  const chain = {
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock((predicate: SQL) => {
      captured.where = predicate;
      return Promise.resolve(rows);
    }),
  };
  return {
    db: { select: mock(() => chain) },
    captured,
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
  opts: Partial<Parameters<typeof prewarmPersonalAgents>[5]> & {
    templateKeys: string[];
  },
) {
  return prewarmPersonalAgents(
    db as never,
    router as never,
    {} as never,
    {} as never,
    {} as never,
    {
      activeWindowMs: 24 * 60 * 60 * 1000,
      concurrency: 2,
      ...opts,
    },
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

  it("composes the selection predicate over template key, activity cutoff, and relaunchable status", async () => {
    const { db, captured } = makeDb([]);
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const windowMs = 60 * 60 * 1000;
    await run(db, makeRouter([]), {
      templateKeys: MYRA_KEYS,
      activeWindowMs: windowMs,
      now,
    });

    expect(captured.where).toBeDefined();
    const query = new PgDialect().sqlToQuery(captured.where as SQL);
    expect(query.sql).toContain("template_key");
    expect(query.sql).toContain("last_activity_at");
    expect(query.sql).toContain("status");
    expect(query.params).toContain("myra");
    // The activity cutoff parameter is exactly now - activeWindowMs.
    const cutoff = new Date(now - windowMs);
    const hasCutoff = query.params.some((p) => {
      if (p instanceof Date) return p.getTime() === cutoff.getTime();
      if (typeof p === "string") {
        return new Date(p).getTime() === cutoff.getTime();
      }
      return false;
    });
    expect(hasCutoff).toBe(true);
    // The wedge sweep's relaunchable statuses gate re-selection of stopped /
    // errored instances.
    for (const status of ["running", "deployed", "updating"]) {
      expect(query.params).toContain(status);
    }
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

  it("isolates a single instance's launch failure and retries it on the next sweep", async () => {
    const { db } = makeDb([
      { instanceId: "ins-bad", address: "bad@t.localhost" },
      { instanceId: "ins-good", address: "good@t.localhost" },
    ]);

    relaunchImpl = (instanceId) =>
      instanceId === "ins-bad"
        ? Promise.reject(new Error("launch write failed"))
        : Promise.resolve();

    // A failing launch must not abort the sibling or reject the sweep.
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS, concurrency: 1 });
    const firstPass = relaunchInstanceIfNeeded.mock.calls.map((c) => c[4]);
    expect(firstPass).toContain("ins-good");
    expect(firstPass).toContain("ins-bad");

    // Next sweep re-attempts the still-cold instance (no permanent give-up).
    relaunchInstanceIfNeeded.mockClear();
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS, concurrency: 1 });
    expect(relaunchInstanceIfNeeded.mock.calls.map((c) => c[4])).toContain(
      "ins-bad",
    );
  });

  it("aborts the rest of the tick on a sidecar-unavailable provision failure so un-attempted candidates stay unarmed", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      instanceId: `ins-${i}`,
      address: `a${i}@t.localhost`,
    }));
    const { db } = makeDb(rows);

    relaunchImpl = () =>
      Promise.reject(
        new SessionLaunchError(
          "provision",
          new Error('No sidecar available for agent "a0@t.localhost"'),
          false,
        ),
      );

    // Serial drain: the first candidate fails with sidecar-unavailable and the
    // remaining four must never be attempted (no cooldowns armed for them).
    await run(db, makeRouter([]), { templateKeys: MYRA_KEYS, concurrency: 1 });
    expect(relaunchInstanceIfNeeded).toHaveBeenCalledTimes(1);
  });
});

// ─── isSidecarUnavailableLaunchError ──────────────────────────────────

describe("isSidecarUnavailableLaunchError", () => {
  it("matches only provision-phase launch errors caused by a missing sidecar", () => {
    const unavailable = new SessionLaunchError(
      "provision",
      new Error('No sidecar connected for agent "x"'),
      false,
    );
    expect(isSidecarUnavailableLaunchError(unavailable)).toBe(true);

    const otherProvision = new SessionLaunchError(
      "provision",
      new Error("Deploy already in progress"),
      false,
    );
    expect(isSidecarUnavailableLaunchError(otherProvision)).toBe(false);

    const packPhase = new SessionLaunchError(
      "pack",
      new Error("No sidecar available"),
      false,
    );
    expect(isSidecarUnavailableLaunchError(packPhase)).toBe(false);

    expect(isSidecarUnavailableLaunchError(new Error("No sidecar"))).toBe(
      false,
    );
  });
});

// ─── createPersonalAgentPrewarmTick (reentrancy) ──────────────────────

describe("createPersonalAgentPrewarmTick", () => {
  it("suppresses ticks while a sweep is in flight and allows the next after it settles", async () => {
    const { db } = makeDb([{ instanceId: "ins-1", address: "a1@t.localhost" }]);
    const gate = deferred();
    let gated = true;
    relaunchImpl = () => (gated ? gate.promise : Promise.resolve());

    const tick = createPersonalAgentPrewarmTick({
      db: db as never,
      router: makeRouter([]) as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      activeWindowMs: 1000,
      concurrency: 1,
    });

    tick();
    // Let the first sweep reach the gated launch.
    await new Promise((r) => setTimeout(r, 0));
    expect(relaunchInstanceIfNeeded).toHaveBeenCalledTimes(1);

    // Reentrant ticks while the sweep is still awaiting the launch: suppressed.
    tick();
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(relaunchInstanceIfNeeded).toHaveBeenCalledTimes(1);

    // Once the sweep settles, the next tick runs a fresh sweep.
    gated = false;
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(relaunchInstanceIfNeeded).toHaveBeenCalledTimes(2);
  });
});

// ─── registerPersonalAgentPrewarm (boot grace) ────────────────────────

describe("registerPersonalAgentPrewarm", () => {
  it("does not run any sweep before the initial delay elapses", async () => {
    const { db } = makeDb([{ instanceId: "ins-1", address: "a1@t.localhost" }]);

    const stop = registerPersonalAgentPrewarm({
      db: db as never,
      router: makeRouter([]) as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      activeWindowMs: 1000,
      concurrency: 1,
      intervalMs: 1,
      initialDelayMs: 60_000,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(db.select).not.toHaveBeenCalled();
    stop();
  });

  it("starts sweeping once the initial delay elapses and stops on unsubscribe", async () => {
    const { db } = makeDb([{ instanceId: "ins-1", address: "a1@t.localhost" }]);

    const stop = registerPersonalAgentPrewarm({
      db: db as never,
      router: makeRouter([]) as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      activeWindowMs: 1000,
      concurrency: 1,
      intervalMs: 5,
      initialDelayMs: 1,
    });

    await new Promise((r) => setTimeout(r, 30));
    stop();
    const sweepsWhileRunning = db.select.mock.calls.length;
    expect(sweepsWhileRunning).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 20));
    expect(db.select.mock.calls.length).toBe(sweepsWhileRunning);
  });
});
