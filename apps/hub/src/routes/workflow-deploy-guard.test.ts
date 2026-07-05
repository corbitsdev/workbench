import { describe, expect, it } from "bun:test";
import {
  assertDeployableKind,
  NonCatalogWorkflowKindError,
} from "./workflow-deploy";
import { loadWorkflowCatalogKinds } from "../lib/workflow-catalog";

describe("assertDeployableKind (CL-2811 deploy-kind guard)", () => {
  const catalog = new Set(["brief-builder", "pain-point-collateral"]);

  it("does not throw for a kind in the catalog", () => {
    expect(() => assertDeployableKind("brief-builder", catalog)).not.toThrow();
  });

  it("rejects the observed junk kinds (step names, per-run supervisors)", () => {
    for (const junk of [
      "skipWriteBack",
      "source",
      "source-selection",
      "supervisor-ses_0232a4b9d379ca617b04a3eb27e992ab",
    ]) {
      expect(() => assertDeployableKind(junk, catalog)).toThrow(
        NonCatalogWorkflowKindError,
      );
    }
  });

  it("carries the offending kind on the error", () => {
    try {
      assertDeployableKind("supervisor-ses_abc", catalog);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NonCatalogWorkflowKindError);
      expect((err as NonCatalogWorkflowKindError).kind).toBe(
        "supervisor-ses_abc",
      );
    }
  });
});

describe("guard against the REAL embedded catalog", () => {
  it("accepts every real catalog kind and rejects the junk kinds", async () => {
    const kinds = await loadWorkflowCatalogKinds();
    // The build-time catalog must be non-empty, else the guard would reject
    // every deploy (and the reclaim would treat everything as junk).
    expect(kinds.size).toBeGreaterThan(0);

    // Every real kind passes the guard.
    for (const kind of kinds) {
      expect(() => assertDeployableKind(kind, kinds)).not.toThrow();
    }

    // The junk kinds seen on staging are never in the real catalog.
    for (const junk of [
      "skipWriteBack",
      "source",
      "supervisor-ses_0232a4b9d379ca617b04a3eb27e992ab",
    ]) {
      expect(kinds.has(junk)).toBe(false);
      expect(() => assertDeployableKind(junk, kinds)).toThrow(
        NonCatalogWorkflowKindError,
      );
    }
  });
});
