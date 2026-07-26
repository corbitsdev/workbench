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

// Suppression keys off "this run has an intake signal queued for delivery"
// (CL-4548) — `record.pendingSignal.signalName === "intake"` — not off
// `triggerSource`. Both fields are settable independently here so tests can
// prove the keying is exactly that field, for either start door.
let runTriggerSource: string | null | undefined = null;
let runPendingSignal: { signalName: string } | null | undefined = null;

mock.module("./run-store", () => ({
  loadDeploymentMeta: async () => deploymentMeta,
  loadRunRecord: async () =>
    runTriggerSource === undefined
      ? null
      : { triggerSource: runTriggerSource, pendingSignal: runPendingSignal },
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
  runPendingSignal = null;
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

  it("delivers gate mail for a mid-run (post-intake) gate on a scheduler-sourced run whose intake already resolved (CL-4289)", async () => {
    runTriggerSource = "scheduler";
    runPendingSignal = null; // intake's SignalReceived already folded and cleared it
    pendingGates = [{ signalName: "confirm" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.messageKey).toBe("gate:wfr-1:confirm");
  });

  it("does not deliver gate mail for the entry intake gate while its auto-delivery signal is queued (CL-4289 + CL-4548)", async () => {
    runTriggerSource = "scheduler";
    runPendingSignal = { signalName: "intake" };
    pendingGates = [{ signalName: "intake" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(0);
    // Expected auto-resolved case, not a warn-worthy "no readable gate".
    expect(warnLogs).toHaveLength(0);
  });

  it("delivers mail only for the non-intake gate when both intake and a post-intake gate are open with intake queued (CL-4289)", async () => {
    runTriggerSource = "scheduler";
    runPendingSignal = { signalName: "intake" };
    pendingGates = [{ signalName: "intake" }, { signalName: "confirm" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.messageKey).toBe("gate:wfr-1:confirm");
  });

  it("still delivers gate mail for an interactive (non-scheduler) run's gate (unchanged, CL-4289)", async () => {
    runTriggerSource = null;
    runPendingSignal = null;
    pendingGates = [{ signalName: "approval" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.messageKey).toBe("gate:wfr-1:approval");
  });

  // CL-4548: suppression keys off the queued intake signal itself, not off
  // `triggerSource` — a manual start with a supplied (and thus auto-delivered)
  // intake payload must be suppressed exactly like a scheduled one, and a
  // scheduled run with NO stored intake (never queued a signal) must still
  // mail like any other unattended gate.
  it("does not deliver intake gate mail for a MANUALLY-started run whose supplied intake is queued for delivery", async () => {
    runTriggerSource = null; // manual start: never stamped "scheduler"
    runPendingSignal = { signalName: "intake" };
    pendingGates = [{ signalName: "intake" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it("still delivers intake gate mail for a SCHEDULED run that carried no stored intake (nothing was ever queued)", async () => {
    runTriggerSource = "scheduler";
    runPendingSignal = null; // deliverStartIntakeSignal returned false: empty stored intake
    pendingGates = [{ signalName: "intake" }];
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverPendingGateMail(deps(db), {
      ...RUN,
      principalId: "prn-alice",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.messageKey).toBe("gate:wfr-1:intake");
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
