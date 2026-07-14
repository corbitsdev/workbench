import { afterEach, describe, expect, it, mock } from "bun:test";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { HubDb } from "../db";
import type { MailboxWriteArgs } from "../lib/mailbox-write";

// Boundary mocks: the gate-mail orchestrator composes the message and delegates
// the durable write to `writeMailboxMessage`, the open-gate read to
// `describePendingGates`, and the label read to `loadDeploymentMeta`. We capture
// each at its module boundary and assert the composition, not the mocks.

const insertCalls: MailboxWriteArgs[] = [];
const errorLogs: { message: string; ctx: unknown }[] = [];
const warnLogs: { message: string; ctx: unknown }[] = [];

let pendingGates: { signalName: string; payloadSchema?: string }[] = [];
let deploymentMeta: { label?: string } | null = null;

mock.module("../lib/mailbox-write", () => ({
  writeMailboxMessage: async (_db: HubDb, args: MailboxWriteArgs) => {
    insertCalls.push(args);
    return { id: `pmb-${insertCalls.length}` };
  },
}));

mock.module("../lib/principal-mailbox", () => ({
  gateMailMessageKey: (runId: string, signalName: string) =>
    `gate:${runId}:${signalName}`,
}));

mock.module("./pending-gate-info", () => ({
  describePendingGates: async () => pendingGates,
}));

let runTriggerSource: string | null | undefined = null;

mock.module("./run-store", () => ({
  loadDeploymentMeta: async () => deploymentMeta,
  loadRunRecord: async () =>
    runTriggerSource === undefined
      ? null
      : { triggerSource: runTriggerSource },
  setPendingSignal: async () => undefined,
}));

mock.module("../config", () => ({
  getConfig: () => ({
    cors: { origins: ["https://app.example"] },
    auth: { baseUrl: "https://app.example" },
  }),
}));

mock.module("@intx/log", () => ({
  getLogger: () => ({
    error: (message: string, ctx: unknown) => errorLogs.push({ message, ctx }),
    warn: (message: string, ctx: unknown) => warnLogs.push({ message, ctx }),
    info: () => {},
    debug: () => {},
  }),
}));

const { deliverPendingGateMail } = await import("./gate-mail");

const RUN = {
  runId: "wfr-1",
  kind: "pain-point-collateral",
  tenantId: "ten-1",
  deploymentId: "ses_dep-1",
};

function makeDb(opts: {
  owner: { id: string; kind: string; refId: string } | undefined;
  tenant: { domain: string } | undefined;
}): HubDb {
  return {
    query: {
      principal: { findFirst: async () => opts.owner },
      tenant: { findFirst: async () => opts.tenant },
    },
  } as unknown as HubDb;
}

const deps = (db: HubDb) => ({
  db,
  repoStore: {} as never,
  deploymentDomain: "wf.example",
});

afterEach(() => {
  insertCalls.length = 0;
  errorLogs.length = 0;
  warnLogs.length = 0;
  pendingGates = [];
  deploymentMeta = null;
  runTriggerSource = null;
});

describe("deliverPendingGateMail", () => {
  it("writes one mailbox item per open gate to the run owner", async () => {
    pendingGates = [
      { signalName: "approval", payloadSchema: '"approve" | "reject"' },
      { signalName: "review" },
    ];
    deploymentMeta = { label: "Pain Point Collateral" };
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(2);
    const first = insertCalls[0];
    expect(first).toMatchObject({
      tenantId: "ten-1",
      principalId: "prn-alice",
      // Pins the ONE canonical principal-mailbox address format: this
      // writer must match deriveUserMailAddress's output, not a locally
      // reconstructed string.
      address: deriveUserMailAddress({
        userRefId: "alice",
        domain: "tenant.example",
      }),
      fromAddress: "hub@wf.example",
      subject: "A workflow needs you: Pain Point Collateral",
      messageKey: "gate:wfr-1:approval",
    });
    // Unified with the Now feed: an awaiting run resolves to /workflows/:runId
    // (CL-3506), as an absolute URL so it autolinks in the Markdown pane.
    expect(first?.body).toContain("https://app.example/workflows/wfr-1");
    expect(first?.body).not.toContain("/insights/trace/");
    expect(first?.body).toContain("Gate: approval");
    expect(first?.body).toContain('Expected response: "approve" | "reject"');
    // The second gate has no payload schema, so no "Expected response" line.
    const second = insertCalls[1];
    expect(second?.messageKey).toBe("gate:wfr-1:review");
    expect(second?.body).toContain("Gate: review");
    expect(second?.body).not.toContain("Expected response");
  });

  it("falls back to the run kind as the label when deployment meta is absent", async () => {
    pendingGates = [{ signalName: "approval" }];
    deploymentMeta = null;
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls[0]?.subject).toBe(
      "A workflow needs you: pain-point-collateral",
    );
  });

  it("skips and logs an error when the owner principal is not a human user", async () => {
    pendingGates = [{ signalName: "approval" }];
    const db = makeDb({
      owner: { id: "prn-bot", kind: "agent", refId: "agt_x" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), { ...RUN, principalId: "prn-bot" });

    expect(insertCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.message).toContain("No human owner resolvable");
  });

  it("skips and logs an error when the owner principal cannot be found", async () => {
    pendingGates = [{ signalName: "approval" }];
    const db = makeDb({
      owner: undefined,
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-ghost",
    });

    expect(insertCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(1);
  });

  it("skips and logs an error when the tenant row is missing", async () => {
    pendingGates = [{ signalName: "approval" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: undefined,
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.message).toContain("No tenant row");
  });

  it("skips gate mail for scheduler-sourced runs (CL-3528)", async () => {
    runTriggerSource = "scheduler";
    pendingGates = [{ signalName: "confirm" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(0);
  });

  it("writes nothing when no open gate is readable from the log", async () => {
    pendingGates = [];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(0);
    expect(warnLogs).toHaveLength(1);
  });
});
