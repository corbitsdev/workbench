import { describe, expect, test } from "bun:test";

import { agentDeploySourceAssetName, agentSlugFromSourceAssetName } from "./agent-deploy";

describe("agentSlugFromSourceAssetName", () => {
  test("recovers the slug agentDeploySourceAssetName wrapped", () => {
    expect(agentSlugFromSourceAssetName(agentDeploySourceAssetName("echo-bot"))).toBe("echo-bot");
  });

  test("is null for a name this pipeline didn't produce", () => {
    expect(agentSlugFromSourceAssetName("echo-bot")).toBeNull();
    expect(agentSlugFromSourceAssetName("agent-agent-echo-bot-source-source")).toBe(
      "agent-echo-bot-source",
    );
  });
});
