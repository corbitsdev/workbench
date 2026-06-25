import { describe, expect, it } from "bun:test";
import { initSentry } from "./sentry";
import { flushSentry, attachSentrySink } from "./setup";

describe("attachSentrySink", () => {
  it("adds the sentry sink to an app logger but not the logtape meta logger", () => {
    const result = attachSentrySink([
      { category: ["logtape", "meta"], sinks: ["console"] },
      { category: [], sinks: ["console"] },
      { category: "api", sinks: ["console"] },
    ]);

    const meta = result[0]!;
    expect(meta.sinks).toEqual(["console"]);
    expect(meta.parentSinks).toBe("override");

    expect(result[1]!.sinks).toEqual(["console", "sentry"]);
    expect(result[2]!.sinks).toEqual(["console", "sentry"]);
  });

  it("is idempotent and tolerates a logger with no sinks", () => {
    const [withSentry, noSinks] = attachSentrySink([
      { category: [], sinks: ["console", "sentry"] },
      { category: "api" },
    ]);
    expect(withSentry!.sinks).toEqual(["console", "sentry"]);
    expect(noSinks!.sinks).toEqual(["sentry"]);
  });
});

describe("initSentry", () => {
  it("returns null when SENTRY_DSN is unset (no-op)", async () => {
    const prev = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    try {
      expect(await initSentry()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.SENTRY_DSN = prev;
    }
  });
});

describe("flushSentry", () => {
  it("resolves without throwing when Sentry was never initialized", async () => {
    await flushSentry(10);
  });
});
