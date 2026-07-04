import { beforeEach, describe, expect, it } from "bun:test";

import type { InferenceSource } from "@intx/types/runtime";
import { LLM_DEFAULT_MODEL } from "@workbench/agents";

import {
  getCachedCatalogSources,
  resetWorkflowModelSourceCache,
} from "./workflow-model-source-cache";

const TTL = 45_000;

const SOURCE: InferenceSource = {
  id: "off_head",
  provider: "openai-compatible",
  baseURL: "http://llm",
  apiKey: "k",
  model: LLM_DEFAULT_MODEL,
};

beforeEach(() => {
  resetWorkflowModelSourceCache();
});

describe("getCachedCatalogSources", () => {
  it("resolves once and serves subsequent calls within the TTL from cache", async () => {
    let calls = 0;
    const resolve = async (): Promise<InferenceSource[]> => {
      calls += 1;
      return [SOURCE];
    };

    const first = await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    const second = await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000 + TTL - 1,
    });

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it("re-resolves after the TTL elapses", async () => {
    let calls = 0;
    const resolve = async (): Promise<InferenceSource[]> => {
      calls += 1;
      return [SOURCE];
    };

    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000 + TTL + 1,
    });

    expect(calls).toBe(2);
  });

  it("keys on tenant — a different tenant re-resolves", async () => {
    let calls = 0;
    const resolve = async (): Promise<InferenceSource[]> => {
      calls += 1;
      return [SOURCE];
    };

    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    await getCachedCatalogSources({
      tenantId: "t2",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });

    expect(calls).toBe(2);
  });

  it("keys on the declared-model set — a different extra-model set re-resolves", async () => {
    let calls = 0;
    const resolve = async (): Promise<InferenceSource[]> => {
      calls += 1;
      return [SOURCE];
    };

    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: ["writer"],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: ["reviewer"],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });

    expect(calls).toBe(2);
  });

  it("treats the same extra-model set in a different order as one key", async () => {
    let calls = 0;
    const resolve = async (): Promise<InferenceSource[]> => {
      calls += 1;
      return [SOURCE];
    };

    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: ["a", "b"],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: ["b", "a"],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });

    expect(calls).toBe(1);
  });

  it("does not cache a rejected resolve and clears the inflight entry (next call re-resolves)", async () => {
    let calls = 0;
    const resolve = async (): Promise<InferenceSource[]> => {
      calls += 1;
      if (calls === 1) throw new Error("catalog unavailable");
      return [SOURCE];
    };

    await expect(
      getCachedCatalogSources({
        tenantId: "t1",
        extraModels: [],
        resolve,
        ttlMs: TTL,
        now: () => 1_000,
      }),
    ).rejects.toThrow(/catalog unavailable/);

    // A rejection must leave no cache entry AND no dangling inflight promise —
    // the next call within the same TTL window re-resolves and succeeds.
    const second = await getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });

    expect(calls).toBe(2);
    expect(second).toEqual([SOURCE]);
  });

  it("collapses concurrent resolves for the same key into one", async () => {
    let calls = 0;
    let release!: (sources: InferenceSource[]) => void;
    const pending = new Promise<InferenceSource[]>((r) => {
      release = r;
    });
    const resolve = (): Promise<InferenceSource[]> => {
      calls += 1;
      return pending;
    };

    const p1 = getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    const p2 = getCachedCatalogSources({
      tenantId: "t1",
      extraModels: [],
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    release([SOURCE]);
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
  });
});
