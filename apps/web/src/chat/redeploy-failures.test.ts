import { describe, expect, test } from "bun:test";

import { claimAutoRedeploy, releaseAutoRedeploy } from "./redeploy-failures";

describe("auto-redeploy claim", () => {
  test("only the first surface claims an asset until it settles", () => {
    expect(claimAutoRedeploy("asset-x")).toBe(true);
    expect(claimAutoRedeploy("asset-x")).toBe(false);
    expect(claimAutoRedeploy("asset-y")).toBe(true);
    releaseAutoRedeploy("asset-x");
    releaseAutoRedeploy("asset-y");
    expect(claimAutoRedeploy("asset-x")).toBe(true);
    releaseAutoRedeploy("asset-x");
  });
});
