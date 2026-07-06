import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as intxDbReal from "@intx/db";
import type { InferenceSource } from "@intx/types/runtime";

// CL-2804: resolveInstanceSourcesCached reuses the CL-2760 catalog cache on the
// launch hot path. We drive the underlying catalog resolver (`resolveModelSources`)
// through a spy so a test asserts REAL behavior — how many times the DB resolver
// actually ran — rather than the shape of a mocked return.

let resolveCalls: {
  tenantId: string;
  requirements: unknown;
  invokerPreferences: Record<string, unknown>;
}[] = [];
// Per-tenant source result; a tenant absent from the map resolves to no sources
// (ok: false), modelling an empty catalog.
let sourcesByTenant = new Map<string, InferenceSource[]>();

mock.module("@intx/db", () => ({
  ...intxDbReal,
  resolveModelSources: async (
    _db: unknown,
    tenantId: string,
    requirements: unknown,
    opts?: { invokerPreferences?: Record<string, unknown> },
  ) => {
    resolveCalls.push({
      tenantId,
      requirements,
      invokerPreferences: opts?.invokerPreferences ?? {},
    });
    const sources = sourcesByTenant.get(tenantId) ?? [];
    if (sources.length === 0) return { ok: false, reason: "no_requirements" };
    return { ok: true, sources };
  },
}));

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
    workflowDeploy: { modelSourceCacheTtlMs: 45_000 },
  }),
}));

const { resolveInstanceSourcesCached } = await import("./agent-provisioning");
const { resetWorkflowModelSourceCache } = await import(
  "./workflow-model-source-cache"
);

function source(id: string): InferenceSource {
  return {
    id,
    provider: "openai-compatible",
    baseURL: "https://llm.example/v1",
    apiKey: "sk-x",
    model: "deepseek-v4-flash",
    // biome-ignore lint/suspicious/noExplicitAny: minimal source fixture
  } as any;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal agent-definition fixture
function agentRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: "agt-myra",
    modelRequirements: [{ model: "deepseek-v4-flash" }],
    ...overrides,
  };
}

describe("resolveInstanceSourcesCached", () => {
  beforeEach(() => {
    resolveCalls = [];
    sourcesByTenant = new Map([["tn-a", [source("src-a")]]]);
    resetWorkflowModelSourceCache();
  });

  it("resolves the catalog only once for repeated launches of the same definition", async () => {
    const first = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );
    const second = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.sources.map((s) => s.id)).toEqual(["src-a"]);
      expect(second.sources).toEqual(first.sources);
    }
    // The DB resolver ran exactly once despite two launches (the cache hit).
    expect(resolveCalls).toHaveLength(1);
  });

  it("returns a deep copy so a mutating caller cannot corrupt the cached chain", async () => {
    const first = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );
    // Mutate both the array (push) AND a source object's field in place — a
    // shallow [...] copy would leave the latter aliased to the cached entry.
    if (first.ok) {
      first.sources.push(source("mutated"));
      first.sources[0]!.id = "hacked";
    }

    const second = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );
    // The cached chain is intact: neither the extra element nor the in-place
    // field edit leaked back.
    if (second.ok) expect(second.sources.map((s) => s.id)).toEqual(["src-a"]);
  });

  it("keys per tenant — a cached chain never crosses the tenant boundary", async () => {
    sourcesByTenant.set("tn-b", [source("src-b")]);

    const a = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );
    const b = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-b",
      agentRow(),
      null,
    );

    if (a.ok) expect(a.sources.map((s) => s.id)).toEqual(["src-a"]);
    if (b.ok) expect(b.sources.map((s) => s.id)).toEqual(["src-b"]);
    // Distinct tenants each resolve; no cross-tenant cache hit.
    expect(resolveCalls).toHaveLength(2);
  });

  it("does not collide when two definitions require the same model with different capabilities", async () => {
    await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow({ modelRequirements: [{ model: "deepseek-v4-flash" }] }),
      null,
    );
    await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow({
        modelRequirements: [
          { model: "deepseek-v4-flash", capabilities: ["tool-use"] },
        ],
      }),
      null,
    );

    // Same tenant + same model NAME but different required capabilities must
    // re-resolve, not serve the first chain.
    expect(resolveCalls).toHaveLength(2);
  });

  it("bypasses the cache when the instance carries invoker model preferences", async () => {
    const preferences = [
      {
        model: "deepseek-v4-flash",
        providers: { mode: "prefer", order: ["x"] },
      },
    ];
    await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      preferences,
    );
    await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      preferences,
    );

    // Preference-bearing resolutions never share the preference-free cache.
    expect(resolveCalls).toHaveLength(2);
    // ...and the preferences actually reach the resolver.
    expect(resolveCalls[0]?.invokerPreferences).toEqual({
      "deepseek-v4-flash": { mode: "prefer", order: ["x"] },
    });
  });

  it("does not cache a failed resolution — an unavailable model re-resolves next call", async () => {
    sourcesByTenant = new Map(); // tn-a resolves to no sources → ok: false

    const failed = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );
    expect(failed.ok).toBe(false);

    // Catalog heals; the next call must re-resolve rather than serve the pinned
    // failure.
    sourcesByTenant.set("tn-a", [source("src-a")]);
    const healed = await resolveInstanceSourcesCached(
      // biome-ignore lint/suspicious/noExplicitAny: db unused by the mock
      {} as any,
      "tn-a",
      agentRow(),
      null,
    );

    expect(healed.ok).toBe(true);
    if (healed.ok) expect(healed.sources.map((s) => s.id)).toEqual(["src-a"]);
    expect(resolveCalls).toHaveLength(2);
  });
});
