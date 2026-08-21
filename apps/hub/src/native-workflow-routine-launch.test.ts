// Proves the routing this repo's routine launcher needed to stop
// silently dropping every step of a multi-step definition: given a
// live, self-anchored native deployment, `triggerNativeWorkflowRoutineRun`
// delivers one signed mail to it via `SidecarRouter.routeMail` and
// returns its anchor run id; given no live deployment, it fails loud
// with a named, consumer-facing error rather than silently doing
// nothing.
import { describe, expect, test } from "bun:test";
import {
  NativeWorkflowDeploymentMissingError,
  triggerNativeWorkflowRoutineRun,
} from "./native-workflow-routine-launch";

type FakeRow = {
  id: string;
  definitionId: string;
  tenantId: string;
  anchorRunId: string;
  address: string | null;
  status: string;
  createdAt: Date;
};

function createFakeDb(rows: FakeRow[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () =>
              rows
                .filter((row) => row.anchorRunId === row.id)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
          }),
        }),
      }),
    }),
  };
}

const LIVE_ANCHOR: FakeRow = {
  id: "wfr_anchor1",
  definitionId: "wfd_multistep",
  tenantId: "ten_1",
  anchorRunId: "wfr_anchor1",
  address: "wfr_anchor1@acme.workbench.test",
  status: "deployed",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "ten_1",
    definitionId: "wfd_multistep",
    principalId: "usr_1",
    fromDomain: "acme.workbench.test",
    content: "Run this routine now.",
    ...overrides,
  };
}

describe("triggerNativeWorkflowRoutineRun", () => {
  test("fires a signed mail at the definition's live deployment and returns its anchor run id", async () => {
    const routeMailCalls: unknown[] = [];
    const result = await triggerNativeWorkflowRoutineRun(
      {
        db: createFakeDb([LIVE_ANCHOR]) as never,
        sidecarRouter: {
          routeMail: (address: string, base64: string, messageId: string) => {
            routeMailCalls.push({ address, base64, messageId });
            return true;
          },
        } as never,
      },
      baseParams(),
    );

    expect(result).toEqual({
      runId: "wfr_anchor1",
      address: "wfr_anchor1@acme.workbench.test",
    });
    expect(routeMailCalls).toHaveLength(1);
    const [call] = routeMailCalls as [
      { address: string; base64: string; messageId: string },
    ];
    expect(call.address).toBe("wfr_anchor1@acme.workbench.test");
    expect(typeof call.base64).toBe("string");
    expect(call.base64.length).toBeGreaterThan(0);
  });

  test("throws a named error when the definition has no live deployment", async () => {
    await expect(
      triggerNativeWorkflowRoutineRun(
        {
          db: createFakeDb([]) as never,
          sidecarRouter: { routeMail: () => true } as never,
        },
        baseParams(),
      ),
    ).rejects.toThrow(NativeWorkflowDeploymentMissingError);
  });

  test("throws the same named error when the only deployment is terminal", async () => {
    await expect(
      triggerNativeWorkflowRoutineRun(
        {
          db: createFakeDb([{ ...LIVE_ANCHOR, status: "completed" }]) as never,
          sidecarRouter: { routeMail: () => true } as never,
        },
        baseParams(),
      ),
    ).rejects.toThrow(NativeWorkflowDeploymentMissingError);
  });

  test("surfaces a real error when the deployment is unrouteable, rather than reporting a silent success", async () => {
    await expect(
      triggerNativeWorkflowRoutineRun(
        {
          db: createFakeDb([LIVE_ANCHOR]) as never,
          sidecarRouter: { routeMail: () => false } as never,
        },
        baseParams(),
      ),
    ).rejects.toThrow(/not routable/);
  });
});
