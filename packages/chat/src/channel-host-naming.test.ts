import { describe, expect, test } from "bun:test";

import {
  channelHostAssetName,
  isChannelHostDefinitionName,
} from "./channel-host-naming";

const RUN_ID = "run_682bf127e22124c01b4b0996aabaab5f";
const INSTANCE_ID = "ins_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("channelHostAssetName", () => {
  test("slugifies generated channel ids deterministically", () => {
    expect(channelHostAssetName(RUN_ID)).toBe(
      "run-682bf127e22124c01b4b0996aabaab5f",
    );
    expect(channelHostAssetName(INSTANCE_ID)).toBe(
      "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    );
  });
});

describe("isChannelHostDefinitionName", () => {
  test("matches the slug of every generated channel id shape", () => {
    expect(isChannelHostDefinitionName(channelHostAssetName(RUN_ID))).toBe(
      true,
    );
    expect(isChannelHostDefinitionName(channelHostAssetName(INSTANCE_ID))).toBe(
      true,
    );
  });

  test("never matches a purpose-run or agent definition name", () => {
    expect(isChannelHostDefinitionName("assistant")).toBe(false);
    expect(isChannelHostDefinitionName("echo")).toBe(false);
    expect(isChannelHostDefinitionName("channel-digest")).toBe(false);
    expect(isChannelHostDefinitionName("run-my-report")).toBe(false);
    expect(isChannelHostDefinitionName("ins-tall-helper")).toBe(false);
    expect(isChannelHostDefinitionName("run-682bf127")).toBe(false);
  });
});
