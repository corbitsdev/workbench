// The workbench-host naming contract: names derived from generated workbench
// ids must stay inside the asset-name grammar, and the predicate over
// definition names must agree with the derivation — that agreement is
// what lets a UI filter anchor runs out of workflow listings without a
// name list. Workbench ids come in two generated shapes (`run_<32 hex>`
// from POST /workbenches, `ins_<32 hex>` historically), so the predicate
// recognizes exactly those slugs and nothing looser.

import { describe, expect, test } from "bun:test";

import {
  workbenchHostAssetName,
  isWorkbenchHostDefinitionName,
} from "../src/workbench-host-naming";

const ASSET_NAME_GRAMMAR = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const RUN_ID = "run_682bf127e22124c01b4b0996aabaab5f";
const INSTANCE_ID = "ins_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("workbenchHostAssetName", () => {
  test("slugifies a generated workbench id into the asset-name grammar", () => {
    for (const id of [RUN_ID, INSTANCE_ID, INSTANCE_ID.toUpperCase()]) {
      const name = workbenchHostAssetName(id);
      expect(name).toMatch(ASSET_NAME_GRAMMAR);
    }
    expect(workbenchHostAssetName(RUN_ID)).toBe(
      "run-682bf127e22124c01b4b0996aabaab5f",
    );
    expect(workbenchHostAssetName(INSTANCE_ID)).toBe(
      "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    );
  });

  test("collapses runs of non-alphanumerics and trims edge dashes", () => {
    expect(workbenchHostAssetName("__ins__ab--cd__")).toBe("ins-ab-cd");
  });
});

describe("isWorkbenchHostDefinitionName", () => {
  test("recognizes the slug of every generated workbench id shape", () => {
    expect(isWorkbenchHostDefinitionName(workbenchHostAssetName(RUN_ID))).toBe(
      true,
    );
    expect(
      isWorkbenchHostDefinitionName(workbenchHostAssetName(INSTANCE_ID)),
    ).toBe(true);
  });

  test("leaves purpose-run and agent definition names alone", () => {
    expect(isWorkbenchHostDefinitionName("assistant")).toBe(false);
    expect(isWorkbenchHostDefinitionName("echo")).toBe(false);
    expect(isWorkbenchHostDefinitionName("workbench-digest")).toBe(false);
    expect(isWorkbenchHostDefinitionName("insights-digest")).toBe(false);
    expect(isWorkbenchHostDefinitionName("run-my-report")).toBe(false);
    expect(isWorkbenchHostDefinitionName("ins-tall-helper")).toBe(false);
    expect(isWorkbenchHostDefinitionName("run-682bf127")).toBe(false);
  });
});
