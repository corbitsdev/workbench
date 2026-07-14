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
const { resetFailureNotificationBreaker } = await import(
  "./failure-notification-breaker"
);

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
  resetFailureNotificationBreaker();
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

  it("truncates a giant error blob to a bounded length", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      status: "failed",
      error: "x".repeat(5000),
    });

    const body = insertCalls[0]?.body ?? "";
    // The 5000-char blob must not survive whole; the cap is ~500 + a fence.
    expect(body).toContain("…");
    expect(body.length).toBeLessThan(1000);
  });

  it("renders a markdown-injection error string inert (fenced), never as live markup", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      status: "failed",
      error: "[click me](javascript:alert(1))",
    });

    const body = insertCalls[0]?.body ?? "";
    // The raw injection text is preserved verbatim but wrapped in a code fence,
    // so the markdown renderer treats it as literal text, not a link.
    expect(body).toContain("```");
    expect(body).toContain("[click me](javascript:alert(1))");
    const fenceIdx = body.indexOf("```");
    const linkIdx = body.indexOf("[click me]");
    expect(fenceIdx).toBeLessThan(linkIdx);
  });

  it("uses a longer fence when the error text contains a triple backtick", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      status: "failed",
      error: "before ``` after",
    });

    const body = insertCalls[0]?.body ?? "";
    // A fence longer than the embedded run so the content cannot break out.
    expect(body).toContain("````");
  });

  it("skips mail entirely for a cancelled run (folded to failed with error 'cancelled')", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      status: "failed",
      error: "cancelled",
    });

    expect(insertCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it("suppresses failure mail after 3 consecutive failures, then a success resets it", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });
    storedPrefs = { notifyRunCompletion: true };

    // Three consecutive failures of the same kind → three mails.
    for (let i = 0; i < 3; i += 1) {
      await deliverRunTerminalMail(deps(db), {
        ...RUN,
        runId: `wfr-f${i}`,
        status: "failed",
        error: "boom",
      });
    }
    expect(insertCalls).toHaveLength(3);
    // The 3rd mail warns that notifications are now paused.
    expect(insertCalls[2]?.body).toContain("paused");

    // Fourth failure is suppressed.
    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      runId: "wfr-f3",
      status: "failed",
      error: "boom",
    });
    expect(insertCalls).toHaveLength(3);

    // A success for the same kind resets the breaker (completion mail is on).
    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      runId: "wfr-ok",
      status: "completed",
    });
    expect(insertCalls).toHaveLength(4);

    // The next failure delivers again — the budget re-armed.
    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      runId: "wfr-f4",
      status: "failed",
      error: "boom",
    });
    expect(insertCalls).toHaveLength(5);
  });

  it("does not let a different workflow kind's failures share a suppression budget", async () => {
    const db = makeDb({
      owner: { id: "prn-alice", kind: "user", refId: "alice" },
      tenant: { domain: "tenant.example" },
    });

    for (let i = 0; i < 4; i += 1) {
      await deliverRunTerminalMail(deps(db), {
        ...RUN,
        runId: `wfr-a${i}`,
        status: "failed",
        error: "boom",
      });
    }
    // kind A: 3 delivered, 4th suppressed.
    expect(insertCalls).toHaveLength(3);

    // A different kind still has its full budget.
    await deliverRunTerminalMail(deps(db), {
      ...RUN,
      kind: "other-workflow",
      runId: "wfr-b0",
      status: "failed",
      error: "boom",
    });
    expect(insertCalls).toHaveLength(4);
  });
});
