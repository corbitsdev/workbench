import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as intxDb from "@intx/db";
import { LLM_DEFAULT_MODEL, LLM_WRITER_MODEL } from "@workbench/agents";
import type { InferenceSource } from "@intx/types/runtime";
import type { WorkflowDefinition } from "@intx/workflow";
import type { HubDb } from "../db";

// resolveWorkflowDeploySource resolves the tenant catalog chain for the default
// model (required) plus any model a step declares as a preference (optional,
// driven off the definition). Mock that boundary, keyed by the requested model,
// so the deploy-config tests exercise the chain → HarnessConfig wiring without a
// real catalog.
let resolution: unknown = { ok: true, sources: [] };
let writerResolution: unknown = {
  ok: false,
  reason: "model_unavailable",
  model: LLM_WRITER_MODEL,
  skips: [],
};
const resolveModelSources = mock(
  async (_db: unknown, _tenantId: string, requirements: { model: string }[]) =>
    requirements[0]?.model === LLM_WRITER_MODEL ? writerResolution : resolution,
);
mock.module("@intx/db", () => ({ ...intxDb, resolveModelSources }));

// The catalog cache reads its TTL from getConfig(); apps/hub tests do not
// preload test-setup/loadConfig, so stub the one field the cache touches.
mock.module("../config", () => ({
  getConfig: () => ({ workflowDeploy: { modelSourceCacheTtlMs: 45_000 } }),
}));

const {
  collectDeclaredStepModels,
  collectDeclaredStepModelMaxTokens,
  resolveWorkflowDeployConfig,
  assembleWorkflowDeployConfig,
} = await import("./workflow-deploy-config");

const { resetWorkflowModelSourceCache } = await import(
  "./workflow-model-source-cache"
);

// Catalog resolution is now memoized per (tenant, model-set) (CL-2760); clear it
// between cases so each test's resolveModelSources call-count and returned chain
// reflect a fresh resolve rather than a prior test's cached entry.
beforeEach(() => {
  resetWorkflowModelSourceCache();
});

afterAll(() => {
  mock.restore();
});

const HEAD: InferenceSource = {
  id: "off_head",
  provider: "openai-compatible",
  baseURL: "http://llm-a",
  apiKey: "ka",
  model: LLM_DEFAULT_MODEL,
};
const FAILOVER: InferenceSource = {
  id: "off_failover",
  provider: "xai",
  baseURL: "http://llm-b",
  apiKey: "kb",
  model: LLM_DEFAULT_MODEL,
};
const WRITER: InferenceSource = {
  id: "off_writer",
  provider: "openai-compatible",
  baseURL: "http://llm-w",
  apiKey: "kw",
  model: LLM_WRITER_MODEL,
};

const db = {} as unknown as HubDb;

// A definition whose `write` step declares the writer model as a preferred
// source — drives the optional extra-model resolution.
const WRITER_DEF = {
  id: "wf",
  triggers: [{ type: "manual" }],
  stepOrder: ["write"],
  steps: {
    write: {
      kind: "step",
      agent: {
        inference: {
          sources: [{ provider: "openai-compatible", model: LLM_WRITER_MODEL }],
        },
      },
    },
  },
} as unknown as WorkflowDefinition;

// A definition whose `write` step declares the writer model AND a per-step
// maxTokens ceiling on its preferred source's parameters (what
// inlineInferenceStep({ model, maxTokens }) emits). Drives the lift onto
// InferenceSource.defaults.maxTokens.
const WRITER_DEF_MAXTOKENS = {
  id: "wf",
  triggers: [{ type: "manual" }],
  stepOrder: ["write"],
  steps: {
    write: {
      kind: "step",
      agent: {
        inference: {
          sources: [
            {
              provider: "openai-compatible",
              model: LLM_WRITER_MODEL,
              parameters: { maxTokens: 16384 },
            },
          ],
        },
      },
    },
  },
} as unknown as WorkflowDefinition;

// A definition with no per-step model preference — resolves the default only.
const PLAIN_DEF = {
  id: "wf",
  triggers: [{ type: "manual" }],
  stepOrder: ["intake"],
  steps: { intake: { kind: "step", agent: { inference: { sources: [] } } } },
} as unknown as WorkflowDefinition;

const args = {
  db,
  tenantId: "ten",
  principalId: "prn",
  deploymentDomain: "local",
  definition: PLAIN_DEF,
};

describe("resolveWorkflowDeployConfig", () => {
  test("a definition with no model preference resolves the default chain only", async () => {
    resolution = { ok: true, sources: [HEAD, FAILOVER] };
    writerResolution = { ok: true, sources: [WRITER] };
    resolveModelSources.mockClear();

    // PLAIN_DEF declares no per-step model, so no extra model is resolved and the
    // writer source is NOT spread into a workflow that never uses it.
    const result = await resolveWorkflowDeployConfig(args);

    expect(result.config.sources).toEqual([HEAD, FAILOVER]);
    expect(result.config.defaultSource).toBe(HEAD.id);
    expect(result.config.tenantId).toBe("ten");
    expect(result.config.principalId).toBe("prn");
    expect(result.config.agentAddress).toBe(`${result.deploymentId}@local`);
    expect(result.config.agentId).toBe(result.deploymentId);

    const models = resolveModelSources.mock.calls.map(
      (c) => (c[2] as { model: string }[])[0]?.model,
    );
    expect(models).toContain(LLM_DEFAULT_MODEL);
    expect(models).not.toContain(LLM_WRITER_MODEL);
  });

  test("appends a step-declared model's sources after the default chain", async () => {
    resolution = { ok: true, sources: [HEAD] };
    writerResolution = { ok: true, sources: [WRITER] };

    const result = await resolveWorkflowDeployConfig({
      ...args,
      definition: WRITER_DEF,
    });

    // The write step declares the writer model, so it is resolved and appended;
    // the head stays the deploy default so steps with no preference ride it.
    expect(result.config.sources).toEqual([HEAD, WRITER]);
    expect(result.config.defaultSource).toBe(HEAD.id);
  });

  test("lifts a step-declared maxTokens onto the matching resolved source's defaults", async () => {
    resolution = { ok: true, sources: [HEAD] };
    writerResolution = { ok: true, sources: [WRITER] };

    const result = await resolveWorkflowDeployConfig({
      ...args,
      definition: WRITER_DEF_MAXTOKENS,
    });

    const writer = result.config.sources.find(
      (s) => s.model === LLM_WRITER_MODEL,
    );
    if (!writer) throw new Error("expected the writer source in the chain");
    // The ceiling lands on the source the runtime reads for the write step, not
    // on the default head — so only the writer turn gets the higher budget.
    expect(writer.defaults?.maxTokens).toBe(16384);
    const head = result.config.sources.find((s) => s.id === HEAD.id);
    expect(head?.defaults?.maxTokens).toBeUndefined();
  });

  test("omits a declared model and never throws when the catalog lacks it", async () => {
    resolution = { ok: true, sources: [HEAD, FAILOVER] };
    writerResolution = {
      ok: false,
      reason: "model_unavailable",
      model: LLM_WRITER_MODEL,
      skips: [],
    };

    const result = await resolveWorkflowDeployConfig({
      ...args,
      definition: WRITER_DEF,
    });

    expect(result.config.sources).toEqual([HEAD, FAILOVER]);
  });

  test("throws a clear error when the model is unavailable in the tenant catalog", async () => {
    resolution = {
      ok: false,
      reason: "model_unavailable",
      model: LLM_DEFAULT_MODEL,
      skips: [],
    };
    await expect(resolveWorkflowDeployConfig(args)).rejects.toThrow(
      /is unavailable in tenant ten \(empty tenant catalog\)/,
    );
  });

  test("surfaces the skip reasons when offerings existed but none was launchable", async () => {
    resolution = {
      ok: false,
      reason: "model_unavailable",
      model: LLM_DEFAULT_MODEL,
      skips: [
        { reason: "credential_unresolved", provider: "openai-compatible" },
      ],
    };
    await expect(resolveWorkflowDeployConfig(args)).rejects.toThrow(
      /skipped: openai-compatible \(credential_unresolved\)/,
    );
  });

  test("throws when there is no model requirement to resolve", async () => {
    resolution = { ok: false, reason: "no_requirements" };
    await expect(resolveWorkflowDeployConfig(args)).rejects.toThrow(
      /no model requirement/,
    );
  });

  test("memoizes the catalog resolution across provisions within the TTL (CL-2760)", async () => {
    resolution = { ok: true, sources: [HEAD, FAILOVER] };
    resolveModelSources.mockClear();

    const first = await resolveWorkflowDeployConfig(args);
    const second = await resolveWorkflowDeployConfig(args);

    // Both provisions produce the resolved chain, but the DB resolver ran only
    // once — the second read served from the (tenant, model-set) memo.
    expect(first.config.sources).toEqual([HEAD, FAILOVER]);
    expect(second.config.sources).toEqual([HEAD, FAILOVER]);
    expect(resolveModelSources.mock.calls.length).toBe(1);
  });

  test("re-resolves for a different tenant even within the TTL (CL-2760)", async () => {
    resolution = { ok: true, sources: [HEAD] };
    resolveModelSources.mockClear();

    await resolveWorkflowDeployConfig({ ...args, tenantId: "ten-a" });
    await resolveWorkflowDeployConfig({ ...args, tenantId: "ten-b" });

    // A distinct tenant is a distinct cache key, so the resolver runs per tenant.
    expect(resolveModelSources.mock.calls.length).toBe(2);
  });
});

describe("assembleWorkflowDeployConfig", () => {
  // A re-drive passes the persisted deploymentId; the derived agentId and
  // agentAddress must be functions of THAT id so they match the rows the
  // original deploy wrote (a fresh id would drift the addresses).
  test("threads the supplied deploymentId into agentId and agentAddress", () => {
    const { deploymentId, config } = assembleWorkflowDeployConfig({
      deploymentId: "ses_persisted",
      tenantId: "t1",
      principalId: "p1",
      deploymentDomain: "deploy.example.com",
      sources: [HEAD, FAILOVER],
    });
    expect(deploymentId).toBe("ses_persisted");
    expect(config.agentId).toBe("ses_persisted");
    expect(config.agentAddress).toBe("ses_persisted@deploy.example.com");
    expect(config.sources).toEqual([HEAD, FAILOVER]);
    expect(config.defaultSource).toBe(HEAD.id);
  });

  test("throws when given no inference sources", () => {
    expect(() =>
      assembleWorkflowDeployConfig({
        deploymentId: "ses_persisted",
        tenantId: "t1",
        principalId: "p1",
        deploymentDomain: "deploy.example.com",
        sources: [],
      }),
    ).toThrow(/no inference sources/);
  });
});

describe("collectDeclaredStepModels", () => {
  test("returns the distinct non-default models a step declares", () => {
    expect(collectDeclaredStepModels(WRITER_DEF)).toEqual([LLM_WRITER_MODEL]);
  });

  test("ignores the default model and steps with no preference", () => {
    const def = {
      id: "wf",
      triggers: [{ type: "manual" }],
      stepOrder: ["a", "b", "gate"],
      steps: {
        a: {
          kind: "step",
          agent: {
            inference: {
              sources: [
                { provider: "openai-compatible", model: LLM_DEFAULT_MODEL },
              ],
            },
          },
        },
        b: { kind: "step", agent: { inference: { sources: [] } } },
        gate: { kind: "awaitSignal", name: "x" },
      },
    } as unknown as WorkflowDefinition;
    expect(collectDeclaredStepModels(def)).toEqual([]);
  });

  test("collectDeclaredStepModelMaxTokens reads the per-model ceiling off the source parameters", () => {
    expect(collectDeclaredStepModelMaxTokens(WRITER_DEF_MAXTOKENS)).toEqual(
      new Map([[LLM_WRITER_MODEL, 16384]]),
    );
    // A def with no declared ceiling yields an empty map (the default chain rides
    // its own catalog defaults).
    expect(collectDeclaredStepModelMaxTokens(WRITER_DEF)).toEqual(new Map());
  });

  test("dedupes a model declared by more than one step", () => {
    const def = {
      id: "wf",
      triggers: [{ type: "manual" }],
      stepOrder: ["a", "b"],
      steps: {
        a: {
          kind: "step",
          agent: {
            inference: {
              sources: [
                { provider: "openai-compatible", model: LLM_WRITER_MODEL },
              ],
            },
          },
        },
        b: {
          kind: "step",
          agent: {
            inference: {
              sources: [
                { provider: "openai-compatible", model: LLM_WRITER_MODEL },
              ],
            },
          },
        },
      },
    } as unknown as WorkflowDefinition;
    expect(collectDeclaredStepModels(def)).toEqual([LLM_WRITER_MODEL]);
  });
});
