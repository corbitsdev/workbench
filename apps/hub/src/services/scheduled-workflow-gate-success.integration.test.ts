import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema } from "../db";
import type { HubDb } from "../db";
import {
  extractStoredIntake,
  queueScheduledIntakeSignal,
} from "../lib/scheduled-intake";
import { resetFeatureGrantCache } from "../lib/feature-grants";
import {
  applyRunProjection,
  insertRunRecord,
  loadRunRecord,
  setPendingSignal,
} from "../workflow-executor/run-store";
import { foldRunEvents } from "../workflow-executor/projection-bridge";
import { createScheduler } from "./scheduler";

const KIND = "scheduler-multi-gate-test";
const AT_9_UTC = Date.UTC(2026, 6, 13, 9, 0, 0);

mock.module("../config", () => ({
  getConfig: () => ({ featureGrantCacheTtlMs: 30_000 }),
}));

const DDL = `
  CREATE TABLE workflow_run_record (
    id text PRIMARY KEY,
    deployment_id text,
    kind text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    input jsonb,
    pending_signal jsonb,
    origin_conversation_id text,
    trigger_source text,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

const GATE_INFOS = new Map([
  [KIND, { requiresIntake: true, humanGateCount: 2 }],
]);

let pendingGates: Array<{ signalName: string }> = [];

const describePendingGatesMock = mock(
  async (): Promise<Array<{ signalName: string }>> => pendingGates,
);

mock.module("../workflow-executor/pending-gate-info", () => ({
  describePendingGates: describePendingGatesMock,
}));

mock.module("../lib/workflow-catalog", () => ({
  loadWorkflowGateInfos: mock(async () => GATE_INFOS),
}));

let client: PGlite;
let db: HubDb;

beforeEach(async () => {
  pendingGates = [];
  resetFeatureGrantCache();
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client.close();
});

describe("scheduler multi-gate success path (CL-3528)", () => {
  test("fires schedule, auto-queues intake, stub drive clears confirm, run completes", async () => {
    const { createScheduledWorkflowGateAgent } = await import(
      "./scheduled-workflow-gate-agent"
    );
    let capturedRunId: string | undefined;

    const driveGate = mock(
      async (args: { runId: string; signalName: string; kind: string }) => {
        expect(args.signalName).toBe("confirm");
        expect(args.kind).toBe(KIND);
        await setPendingSignal(db, args.runId, {
          signalId: randomUUID(),
          signalName: "confirm",
          payload: {},
          receivedAt: new Date().toISOString(),
        });
        pendingGates = [];
        const endedAt = new Date().toISOString();
        await applyRunProjection(db, args.runId, {
          status: "completed",
          endedAt,
          clearPendingSignal: true,
        });
        return { ok: true as const };
      },
    );

    const agent = createScheduledWorkflowGateAgent({
      db,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      cryptoProvider: {} as never,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      driveGate,
      describePendingGatesFn: async () => pendingGates,
    });

    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      listSchedules: async () => [
        {
          id: "sch-multi",
          tenantId: "ten-1",
          workflowKind: KIND,
          intervalMinutes: 1440,
          anchorMinuteUtc: 9 * 60,
          lastFiredWindowIndex: Number.MIN_SAFE_INTEGER,
          ownerMemberPrincipalId: "pri-owner",
          triggerPayload: {
            note: "nightly unattended run",
            userAddress: "usr_pri-owner@tenant.example",
            userRefId: "pri-owner",
          },
        },
      ],
      markFired: async () => {},
      startWorkflowRun: async (fire) => {
        const runId = randomUUID();
        capturedRunId = runId;
        await insertRunRecord(db, {
          runId,
          deploymentId: "dep-multi",
          kind: fire.kind,
          tenantId: fire.tenantId,
          principalId: fire.creatorPrincipalId,
          input: { ...fire.triggerPayload, runId },
          originConversationId: null,
          triggerSource: "scheduler",
        });

        const gateInfo = GATE_INFOS.get(fire.kind);
        if (gateInfo?.requiresIntake === true) {
          const intake = extractStoredIntake(fire.triggerPayload);
          const queued = await queueScheduledIntakeSignal(db, {
            runId,
            kind: fire.kind,
            intake,
          });
          expect(queued).toBe(true);
        }

        const afterIntake = await loadRunRecord(db, runId);
        const intakeSignalId = afterIntake?.pendingSignal?.signalId;
        expect(afterIntake?.pendingSignal?.signalName).toBe("intake");
        expect(afterIntake?.pendingSignal?.payload).toEqual({
          note: "nightly unattended run",
        });

        await applyRunProjection(db, runId, {
          status: "awaiting",
          clearPendingSignal:
            intakeSignalId !== undefined
              ? { signalIds: [intakeSignalId] }
              : undefined,
        });
        pendingGates = [{ signalName: "confirm" }];
        const beforeDrive = await loadRunRecord(db, runId);
        expect(beforeDrive?.triggerSource).toBe("scheduler");

        await agent.maybeEnqueue({
          runId,
          kind: fire.kind,
          tenantId: fire.tenantId,
          principalId: fire.creatorPrincipalId,
          deploymentId: "dep-multi",
          repoStore: {} as never,
        });
        await agent.waitForDrain();

        return { deploymentId: "dep-multi", accepted: true };
      },
    });

    await scheduler.tick(AT_9_UTC);
    await agent.waitForDrain();

    expect(capturedRunId).toBeDefined();
    const final = await loadRunRecord(db, capturedRunId!);
    expect(driveGate).toHaveBeenCalledTimes(1);
    expect(final?.status).toBe("completed");
    expect(final?.triggerSource).toBe("scheduler");
    expect(final?.pendingSignal ?? null).toBeNull();

    const folded = foldRunEvents([
      {
        runId: capturedRunId!,
        event: {
          type: "RunStarted",
          seq: 0,
          at: "2026-07-13T09:00:01.000Z",
        },
      },
      {
        runId: capturedRunId!,
        event: {
          type: "SignalReceived",
          seq: 1,
          signalName: "intake",
          signalId: "sig-intake",
          payload: { note: "nightly unattended run" },
        },
      },
      {
        runId: capturedRunId!,
        event: {
          type: "SignalReceived",
          seq: 2,
          signalName: "confirm",
          signalId: "sig-confirm",
          payload: {},
        },
      },
      {
        runId: capturedRunId!,
        event: {
          type: "RunCompleted",
          seq: 3,
          at: final?.endedAt?.toISOString() ?? "2026-07-13T09:00:10.000Z",
        },
      },
    ]);
    expect(folded.get(capturedRunId!)?.status).toBe("completed");
  });
});
