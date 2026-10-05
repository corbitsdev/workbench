import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { redeployMode } from "./deployment-liveness";
import { markRedeployFailed, clearRedeployFailure } from "./redeploy-failures";
import { listChatAgents } from "./threads-api";

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => {
  fetchSpy.mockReset();
  clearRedeployFailure("asset-1");
});

type Deployment = { id: string; status: string; createdAt: string };
type Run = { id: string; status: string; createdAt: string; updatedAt: string; endedAt?: string };

const T0 = "2026-10-04T10:00:00.000Z";
const T1H = "2026-10-04T11:00:00.000Z";
const T10S = "2026-10-04T11:00:10.000Z";

function hub(deployments: Deployment[], runs: Run[]) {
  fetchSpy.mockImplementation(((input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/workflows/deployments")
      ? deployments.map((d) => ({
          ...d,
          tenantId: "t1",
          definitionAssetId: "asset-1",
        }))
      : url.includes("/workflows/runs")
        ? {
            data: runs.map((r) => ({
              ...r,
              definitionId: "def",
              definitionName: "worker",
              tenantId: "t1",
              address: `${r.id}@bench.example`,
            })),
            nextCursor: null,
          }
        : [{ id: "asset-1", name: "worker" }];
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as typeof fetch);
}

async function agent() {
  const [only] = await listChatAgents("t1");
  if (only === undefined) throw new Error("no agent listed");
  return only;
}

describe("listChatAgents self-heal join", () => {
  test("a hub restart (released deployment, long-lived errored run) redeploys on its own", async () => {
    hub(
      [{ id: "r1", status: "released", createdAt: T0 }],
      [{ id: "r1", status: "error", createdAt: T0, updatedAt: T1H, endedAt: T1H }],
    );
    const listed = await agent();
    expect(listed.liveAddress).toBeNull();
    expect(redeployMode(listed)).toBe("auto");
  });

  test("a deployed projection over a dead run is not live", async () => {
    hub(
      [{ id: "r1", status: "deployed", createdAt: T0 }],
      [{ id: "r1", status: "stopped", createdAt: T0, updatedAt: T1H, endedAt: T1H }],
    );
    expect((await agent()).liveAddress).toBeNull();
  });

  test("a redeploy that died within moments waits for Restart", async () => {
    hub(
      [
        { id: "r2", status: "deployed", createdAt: T1H },
        { id: "r1", status: "released", createdAt: T0 },
      ],
      [
        { id: "r2", status: "error", createdAt: T1H, updatedAt: T10S, endedAt: T10S },
        { id: "r1", status: "error", createdAt: T0, updatedAt: T1H, endedAt: T1H },
      ],
    );
    expect(redeployMode(await agent())).toBe("manual");
  });

  test("a fresh deployment whose run is not addressed yet is starting, not redeployed again", async () => {
    hub(
      [
        { id: "r2", status: "pending", createdAt: T1H },
        { id: "r1", status: "released", createdAt: T0 },
      ],
      [{ id: "r1", status: "error", createdAt: T0, updatedAt: T1H, endedAt: T1H }],
    );
    expect(redeployMode(await agent())).toBeUndefined();
  });

  test("a failed redeploy caps the agent", async () => {
    hub(
      [{ id: "r1", status: "released", createdAt: T0 }],
      [{ id: "r1", status: "error", createdAt: T0, updatedAt: T1H, endedAt: T1H }],
    );
    markRedeployFailed("asset-1");
    expect(redeployMode(await agent())).toBe("manual");
  });

  test("a live run is left alone", async () => {
    hub(
      [{ id: "r1", status: "deployed", createdAt: T0 }],
      [{ id: "r1", status: "running", createdAt: T0, updatedAt: T1H }],
    );
    const listed = await agent();
    expect(listed.liveAddress).toBe("r1@bench.example");
    expect(redeployMode(listed)).toBeUndefined();
  });
});
