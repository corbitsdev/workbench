import { afterAll, describe, expect, mock, test } from "bun:test";
import * as intxDb from "@intx/db";
import { LLM_DEFAULT_MODEL } from "@workbench/agents";
import type { InferenceSource } from "@intx/types/runtime";
import type { HubDb } from "../db";

// resolveWorkflowDeploySource now resolves the tenant catalog chain via
// resolveModelSources; mock that boundary so the deploy-config tests exercise
// the chain → HarnessConfig wiring without a real catalog.
let resolution: unknown = { ok: true, sources: [] };
const resolveModelSources = mock(
  async (_db: unknown, _tenantId: string, _requirements: unknown) => resolution,
);
mock.module("@intx/db", () => ({ ...intxDb, resolveModelSources }));

const { resolveWorkflowDeployConfig, assembleWorkflowDeployConfig } =
  await import("./workflow-deploy-config");

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

const db = {} as unknown as HubDb;

const args = {
  db,
  tenantId: "ten",
  principalId: "prn",
  deploymentDomain: "local",
};

describe("resolveWorkflowDeployConfig", () => {
  test("builds a base config carrying the full catalog chain with the head as default", async () => {
    resolution = { ok: true, sources: [HEAD, FAILOVER] };

    const result = await resolveWorkflowDeployConfig(args);

    expect(result.config.sources).toEqual([HEAD, FAILOVER]);
    expect(result.config.defaultSource).toBe(HEAD.id);
    expect(result.config.tenantId).toBe("ten");
    expect(result.config.principalId).toBe("prn");
    expect(result.config.agentAddress).toBe(`${result.deploymentId}@local`);
    expect(result.config.agentId).toBe(result.deploymentId);

    const call = resolveModelSources.mock.calls.at(-1);
    if (!call) throw new Error("resolveModelSources was not called");
    expect(call[2]).toEqual([{ model: LLM_DEFAULT_MODEL }]);
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
