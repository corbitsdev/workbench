import { afterEach, describe, expect, it, mock } from "bun:test";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { HubDb } from "../db";
import type { MailboxWriteArgs } from "../lib/mailbox-write";

// Boundary mocks, mirroring gate-mail.test.ts: the run-terminal-mail
// orchestrator composes the message and delegates the durable write to
// `writeMailboxMessage`, the preference read to `readMemberPreferences`, and
// the label read to `loadDeploymentMeta`. We capture each at its module
// boundary and assert the composition, not the mocks.

const insertCalls: MailboxWriteArgs[] = [];
const errorLogs: { message: string; ctx: unknown }[] = [];

let storedPrefs: Record<string, unknown> = {};
let deploymentMeta: { label?: string } | null = null;

mock.module("../lib/mailbox-write", () => ({
  writeMailboxMessage: async (_db: HubDb, args: MailboxWriteArgs) => {
    insertCalls.push(args);
    return { id: `pmb-${insertCalls.length}` };
  },
}));

mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async () => storedPrefs,
}));

mock.module("../lib/principal-mailbox", () => ({
  runTerminalMailMessageKey: (runId: string, status: string) =>
    `run:${runId}:${status}`,
}));

mock.module("./run-store", () => ({
  loadDeploymentMeta: async () => deploymentMeta,
}));

mock.module("@intx/log", () => ({
  getLogger: () => ({
    error: (message: string, ctx: unknown) => errorLogs.push({ message, ctx }),
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

const { deliverRunTerminalMail } = await import("./run-terminal-mail");

const RUN = {
  runId: "wfr-1",
  kind: "pain-point-collateral",
  tenantId: "ten-1",
  principalId: "prn-alice",
  deploymentId: "ses_dep-1" as string | null,
  failedSteps: [] as { stepId: string; message: string }[],
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

const deps = (db: HubDb) => ({ db, deploymentDomain: "wf.example" });

afterEach(() => {
  insertCalls.length = 0;
  errorLogs.length = 0;
  storedPrefs = {};
  deploymentMeta = null;
});

describe("deliverRunTerminalMail", () => {
  it("writes a failure mailbox item to the run creator by default", async () => {
    deploymentMeta = { label: "Pain Point Collateral" };
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      status: "failed",
      error: "step failed",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      tenantId: "ten-1",
      principalId: "prn-alice",
      address: deriveUserMailAddress({
        userRefId: "alice",
        domain: "tenant.example",
      }),
      fromAddress: "hub@wf.example",
      subject: "Workflow run failed: Pain Point Collateral",
      messageKey: "run:wfr-1:failed",
    });
    expect(insertCalls[0]?.body).toContain("/insights/trace/wfr-1");
    expect(insertCalls[0]?.body).toContain("step failed");
  });

  it("does not mail a failure when notifyRunFailure is explicitly off", async () => {
    storedPrefs = { notifyRunFailure: false };
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), { ...RUN, status: "failed" });

    expect(insertCalls).toHaveLength(0);
  });

  it("does not mail a completion by default (notifyRunCompletion is OFF)", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), { ...RUN, status: "completed" });

    expect(insertCalls).toHaveLength(0);
  });

  it("mails a completion when notifyRunCompletion is explicitly on", async () => {
    storedPrefs = { notifyRunCompletion: true };
    deploymentMeta = { label: "Pain Point Collateral" };
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), { ...RUN, status: "completed" });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.subject).toBe(
      "Workflow run completed: Pain Point Collateral",
    );
    expect(insertCalls[0]?.messageKey).toBe("run:wfr-1:completed");
  });

  it("falls back to the run kind as the label when deployment meta is absent", async () => {
    deploymentMeta = null;
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), { ...RUN, status: "failed" });

    expect(insertCalls[0]?.subject).toBe(
      "Workflow run failed: pain-point-collateral",
    );
  });

  it("skips and logs an error when the owner principal is not a human user", async () => {
    const db = makeDb({
      owner: { id: "prn-bot", kind: "agent", refId: "agt_x" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), { ...RUN, status: "failed" });

    expect(insertCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.message).toContain("No human owner resolvable");
  });

  it("skips and logs an error when the tenant row is missing", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: undefined,
    });

    await deliverRunTerminalMail(deps(db), { ...RUN, status: "failed" });

    expect(insertCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.message).toContain("No tenant row");
  });

  it("handles a null deploymentId (no deployment to resolve meta from)", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      deploymentId: null,
      status: "failed",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.subject).toBe(
      "Workflow run failed: pain-point-collateral",
    );
  });
});
