/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { dedupeDeployedWorkflows } from "./deployed-workflows";
import type { WorkflowDeployment } from "../hooks/use-workflow";

const meta = {
  version: "0.1.0",
  sha: "abc1234",
  deployedAt: "2026-06-27T00:00:00.000Z",
};

function deployment(
  overrides: Partial<WorkflowDeployment> & { kind: string },
): WorkflowDeployment {
  return {
    deploymentId: "dep-x",
    status: "running",
    createdAt: "",
    ...overrides,
  };
}

describe("dedupeDeployedWorkflows", () => {
  it("returns one entry per kind with the deploy-meta label and description", () => {
    const result = dedupeDeployedWorkflows([
      deployment({
        kind: "collateral-generation",
        meta: {
          ...meta,
          label: "Pain Point Collateral Generation",
          description: "Analyze a call transcript.",
        },
      }),
      deployment({
        deploymentId: "dep-2",
        kind: "collateral-generation",
        meta: { ...meta, label: "Older Label" },
      }),
    ]);
    expect(result).toEqual([
      {
        kind: "collateral-generation",
        label: "Pain Point Collateral Generation",
        description: "Analyze a call transcript.",
      },
    ]);
  });

  it("falls back to a humanized kind when a deployment has no meta label", () => {
    const result = dedupeDeployedWorkflows([
      deployment({ kind: "gamma-presentation-creator" }),
    ]);
    expect(result).toEqual([
      {
        kind: "gamma-presentation-creator",
        label: "Gamma presentation creator",
      },
    ]);
  });

  it("upgrades a humanized fallback when a later row carries a real meta label", () => {
    const result = dedupeDeployedWorkflows([
      deployment({ kind: "seo-enrichment" }),
      deployment({
        deploymentId: "dep-2",
        kind: "seo-enrichment",
        meta: { ...meta, label: "SEO Enrichment Report" },
      }),
    ]);
    expect(result).toEqual([
      { kind: "seo-enrichment", label: "SEO Enrichment Report" },
    ]);
  });

  it("keeps distinct kinds as distinct entries", () => {
    const result = dedupeDeployedWorkflows([
      deployment({ kind: "a-workflow" }),
      deployment({ deploymentId: "dep-2", kind: "b-workflow" }),
    ]);
    expect(result.map((w) => w.kind)).toEqual(["a-workflow", "b-workflow"]);
  });
});
