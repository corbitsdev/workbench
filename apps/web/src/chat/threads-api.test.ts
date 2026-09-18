import { describe, expect, test } from "bun:test";

import { agentDeploySourceAssetName } from "../agent-deploy";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import { displayAgentName } from "./threads-api";

describe("displayAgentName", () => {
  test("renders Myra's fixed display name for her asset", () => {
    expect(displayAgentName(MYRA_SOURCE_CONFIG.assetName)).toBe(MYRA_SOURCE_CONFIG.displayName);
  });

  test("title-cases a deployed agent's slug with hyphens as spaces", () => {
    expect(displayAgentName(agentDeploySourceAssetName("echo-bot"))).toBe("Echo Bot");
    expect(displayAgentName(agentDeploySourceAssetName("scribe"))).toBe("Scribe");
  });

  test("falls back to the raw name for anything unrecognized", () => {
    expect(displayAgentName("some-other-asset")).toBe("some-other-asset");
  });
});
