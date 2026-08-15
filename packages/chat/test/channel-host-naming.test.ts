// The channel-host naming contract: names derived from generated channel
// ids must stay inside the asset-name grammar, and the predicate over
// definition names must agree with the derivation — that agreement is
// what lets a UI filter anchor runs out of workflow listings without a
// name list. Channel ids come in two generated shapes (`run_<32 hex>`
// from POST /channels, `ins_<32 hex>` historically), so the predicate
// recognizes exactly those slugs and nothing looser.

import { describe, expect, test } from "bun:test";

import {
  channelHostAssetName,
  isChannelHostDefinitionName,
} from "../src/channel-host-naming";

const ASSET_NAME_GRAMMAR = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const RUN_ID = "run_682bf127e22124c01b4b0996aabaab5f";
const INSTANCE_ID = "ins_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("channelHostAssetName", () => {
  test("slugifies a generated channel id into the asset-name grammar", () => {
    for (const id of [RUN_ID, INSTANCE_ID, INSTANCE_ID.toUpperCase()]) {
      const name = channelHostAssetName(id);
      expect(name).toMatch(ASSET_NAME_GRAMMAR);
    }
    expect(channelHostAssetName(RUN_ID)).toBe(
      "run-682bf127e22124c01b4b0996aabaab5f",
    );
    expect(channelHostAssetName(INSTANCE_ID)).toBe(
      "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    );
  });

  test("collapses runs of non-alphanumerics and trims edge dashes", () => {
    expect(channelHostAssetName("__ins__ab--cd__")).toBe("ins-ab-cd");
  });
});

describe("isChannelHostDefinitionName", () => {
  test("recognizes the slug of every generated channel id shape", () => {
    expect(isChannelHostDefinitionName(channelHostAssetName(RUN_ID))).toBe(
      true,
    );
    expect(isChannelHostDefinitionName(channelHostAssetName(INSTANCE_ID))).toBe(
      true,
    );
  });

  test("leaves purpose-run and agent definition names alone", () => {
    expect(isChannelHostDefinitionName("assistant")).toBe(false);
    expect(isChannelHostDefinitionName("echo")).toBe(false);
    expect(isChannelHostDefinitionName("channel-digest")).toBe(false);
    expect(isChannelHostDefinitionName("insights-digest")).toBe(false);
    expect(isChannelHostDefinitionName("run-my-report")).toBe(false);
    expect(isChannelHostDefinitionName("ins-tall-helper")).toBe(false);
    expect(isChannelHostDefinitionName("run-682bf127")).toBe(false);
  });
});
