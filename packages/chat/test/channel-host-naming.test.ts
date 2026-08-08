// The channel-host naming contract: names derived from instance ids
// must stay inside the asset-name grammar, always carry the `ins-`
// prefix, and the predicate over definition names must agree with the
// derivation — that agreement is what lets a UI filter anchor runs out
// of workflow listings without a name list.

import { describe, expect, test } from "bun:test";

import {
  CHANNEL_HOST_ASSET_NAME_PREFIX,
  channelHostAssetName,
  isChannelHostDefinitionName,
} from "../src/channel-host-naming";

const ASSET_NAME_GRAMMAR = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("channelHostAssetName", () => {
  test("slugifies an instance id into the asset-name grammar", () => {
    const name = channelHostAssetName("ins_cd03d8e3A4");
    expect(name).toBe("ins-cd03d8e3a4");
    expect(name).toMatch(ASSET_NAME_GRAMMAR);
  });

  test("collapses runs of non-alphanumerics and trims edge dashes", () => {
    expect(channelHostAssetName("__ins__ab--cd__")).toBe("ins-ab-cd");
  });

  test("every instance-id-shaped input yields the channel-host prefix", () => {
    for (const id of ["ins_0", "INS_ABC123", "ins_ffffffffffffffff"]) {
      expect(
        channelHostAssetName(id).startsWith(CHANNEL_HOST_ASSET_NAME_PREFIX),
      ).toBe(true);
    }
  });
});

describe("isChannelHostDefinitionName", () => {
  test("recognizes a name the derivation produced", () => {
    expect(
      isChannelHostDefinitionName(channelHostAssetName("ins_cd03d8e3")),
    ).toBe(true);
  });

  test("leaves purpose-run workflow definitions alone", () => {
    expect(isChannelHostDefinitionName("assistant")).toBe(false);
    expect(isChannelHostDefinitionName("echo")).toBe(false);
    expect(isChannelHostDefinitionName("insights-digest")).toBe(false);
  });
});
