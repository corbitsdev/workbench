// CL-7585: the catalog set pin. The seeding package's move into
// `@workbench/onboarding`'s `tenant-seed` stripped every assertion on
// the catalog set itself — and the hub's boot list promptly drifted to
// five names including three phantoms. These tests pin the wiring in
// the open: the names the hub and the Routines Available list consume
// derive from `CATALOG_WORKFLOWS` (never a second handwritten copy),
// every catalog name resolves a `WORKFLOW_CATALOG` entry (the skip
// branch `@corbits/workflows`' `available-catalog` documents), and
// every catalog entry answers a real rendering builder through
// `deployableCatalogWorkflow` — the exact function the hub's
// block-workflow deploy path wires through.
import { describe, expect, test } from "bun:test";
import { workflowCatalogEntry } from "@corbits/workflows/catalog";
import {
  CATALOG_WORKFLOWS,
  CATALOG_WORKFLOW_ASSET_NAMES,
  DEFAULT_WORKFLOWS,
  deployableCatalogWorkflow,
  SETUP_AGENT_ASSET_NAME,
} from "../src/tenant-seed";

const FAKE_INFERENCE_PREFERENCES = [{ provider: "ollama", model: "qwen-test" }];

describe("catalog workflow names", () => {
  test("the exported names derive from CATALOG_WORKFLOWS, never a second list", () => {
    expect([...CATALOG_WORKFLOW_ASSET_NAMES]).toEqual(
      CATALOG_WORKFLOWS.map((workflow) => workflow.assetName),
    );
  });

  test("the default set is the setup agent only; every other source package is an on-demand catalog entry", () => {
    // provisionPersonalTenantIfNeeded deploys DEFAULT_WORKFLOWS for
    // every real signup (CL-7074: Myra only). Everything else deploys
    // on demand (CL-7073) from CATALOG_WORKFLOWS, never automatically.
    expect(DEFAULT_WORKFLOWS.map((w) => w.assetName)).toEqual([SETUP_AGENT_ASSET_NAME]);
    expect([...CATALOG_WORKFLOW_ASSET_NAMES]).toEqual([
      "echo",
      "workbench-digest",
      "last-30-days-research",
      "code-review",
      "granola-call",
      "morning-brief",
      "exa-topic-watch",
      "process-granola-call",
      "attio-task-agent",
      "pain-point-collateral",
      "reddit-opportunity-scanner",
      "collateral-generation",
      "diligence-brief",
    ]);
  });

  test("every catalog name resolves a WORKFLOW_CATALOG entry", () => {
    // `@corbits/workflows`' `available-catalog` skips a catalog name
    // with no entry rather than throwing; this guard keeps that skip
    // branch dead by construction.
    for (const assetName of CATALOG_WORKFLOW_ASSET_NAMES) {
      expect(
        workflowCatalogEntry(assetName),
        `catalog workflow ${assetName} has no WORKFLOW_CATALOG entry`,
      ).toBeDefined();
    }
  });
});

describe("deployableCatalogWorkflow", () => {
  test("every catalog entry answers with a builder rendering its own definition", () => {
    for (const workflow of CATALOG_WORKFLOWS) {
      const found = deployableCatalogWorkflow(workflow.assetName);
      expect(found, `catalog workflow ${workflow.assetName} answers`).toBeDefined();
      const json = found?.buildJson("acme.example", FAKE_INFERENCE_PREFERENCES);
      // A real rendered definition for THIS workflow: it parses, it
      // has steps to launch, and it names its own asset. (Not every
      // entry is mail-triggered — the scheduled ones stamp no trigger
      // address — so the name, not the address, is the per-workflow
      // pin.)
      const parsed = JSON.parse(json as string) as {
        stepOrder?: readonly string[];
      };
      expect(parsed.stepOrder?.length).toBeGreaterThan(0);
      expect(json).toContain(workflow.assetName);
    }
  });

  test("the seeded agent, the test-only workflow, and unknown names answer undefined", () => {
    // `assistant` is seeded, never redeployed through the catalog
    // instantiate path; `heartbeat` exercises the platform only.
    expect(deployableCatalogWorkflow(SETUP_AGENT_ASSET_NAME)).toBeUndefined();
    expect(deployableCatalogWorkflow("heartbeat")).toBeUndefined();
    expect(deployableCatalogWorkflow("kitchen-sink-loop")).toBeUndefined();
  });
});
