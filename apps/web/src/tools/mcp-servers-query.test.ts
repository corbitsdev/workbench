// The workspace redeploy loop: one workbench's failure never stops the rest,
// and the failures come back named so the Tools page can say which Myras are
// still running the old catalog.

import { describe, expect, test } from "bun:test";

import { describeRedeployResult, redeployMyraTenants } from "./mcp-servers-query";

const MYRA = { id: "agent-myra", name: "Myra", assetName: "myra" };

describe("redeployMyraTenants", () => {
  test("a failed redeploy is named, and the rest still go out", async () => {
    const redeployed: string[] = [];
    const result = await redeployMyraTenants(
      [
        { id: "ws", name: "workspace" },
        { id: "wb-a", name: "Alpha" },
        { id: "wb-b", name: "Beta" },
      ],
      {
        findMyra: async () => MYRA,
        redeploy: async (tenantId) => {
          if (tenantId === "wb-a") throw new Error("boom");
          redeployed.push(tenantId);
        },
      },
    );
    expect(result.redeployed).toBe(2);
    expect(redeployed).toEqual(["ws", "wb-b"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ tenantId: "wb-a", workbenchName: "Alpha" });
    expect(result.failed[0]?.error).toBe("Something went wrong redeploying Myra. Try again.");
  });

  test("a workbench that cannot be read is named instead of stopping the loop", async () => {
    const redeployed: string[] = [];
    const result = await redeployMyraTenants(
      [
        { id: "wb-a", name: "Alpha" },
        { id: "wb-b", name: "Beta" },
      ],
      {
        findMyra: async (tenantId) => {
          if (tenantId === "wb-a") throw new Error("gone");
          return MYRA;
        },
        redeploy: async (tenantId) => {
          redeployed.push(tenantId);
        },
      },
    );
    expect(result.redeployed).toBe(1);
    expect(redeployed).toEqual(["wb-b"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ tenantId: "wb-a", workbenchName: "Alpha" });
  });

  test("a workbench without Myra is skipped, not failed", async () => {
    const result = await redeployMyraTenants([{ id: "wb-a", name: "Alpha" }], {
      findMyra: async () => undefined,
      redeploy: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result).toEqual({ redeployed: 0, failed: [] });
  });
});

describe("describeRedeployResult", () => {
  test("a clean redeploy names the count", () => {
    expect(describeRedeployResult({ redeployed: 2, failed: [] })).toBe(
      "Myra redeployed in 2 workbenches.",
    );
    expect(describeRedeployResult({ redeployed: 1, failed: [] })).toBe(
      "Myra redeployed in 1 workbench.",
    );
  });

  test("a partial failure names the stale workbenches", () => {
    expect(
      describeRedeployResult({
        redeployed: 1,
        failed: [{ tenantId: "wb-a", workbenchName: "Alpha", error: "Something went wrong." }],
      }),
    ).toBe(
      "Myra redeployed in 1 workbench, but the redeploy failed in Alpha — " +
        "those workbenches still run the old catalog. Try the change again.",
    );
  });
});
