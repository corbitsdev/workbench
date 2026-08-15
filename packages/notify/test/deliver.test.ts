import { describe, expect, test } from "bun:test";

import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  deliverApprovalMail,
  deliverCredentialMail,
  deliverMentionMail,
  deliverNotification,
  deliverRunFailureMail,
  deliverTaskResultMail,
  InvalidNotificationEventError,
  NOTIFY_MAIL_SOURCE,
  type MailboxDelivery,
  type NotifyAddressing,
  type NotifyDeliveryDeps,
  type NotifyInboxItem,
  type SinkDeliveryResult,
} from "../src/index";

const addressing: NotifyAddressing = {
  inbox: (recipient) => `${recipient.principalId}@bench.invalid`,
  from: (kind) => `${kind}@notify.invalid`,
};

function recordingMailbox(): {
  mail: MailboxDelivery;
  written: NotifyInboxItem[];
} {
  const written: NotifyInboxItem[] = [];
  let next = 0;
  const mail: MailboxDelivery = async (items, opts) => {
    return items.map((item) => {
      written.push(item);
      next += 1;
      const id = `mail-${next}`;
      opts?.enqueue?.({ id, item });
      return { messageKey: `key-${id}`, id };
    });
  };
  return { mail, written };
}

function dedupingMailbox(): MailboxDelivery {
  return async (items) =>
    items.map((item) => ({ messageKey: item.externalId, id: null }));
}

function depsWith(mail: MailboxDelivery): NotifyDeliveryDeps {
  return {
    mail,
    addressing,
    dispatch: createInMemoryNotifyDispatchStore(),
    sinks: createSinkRegistry(),
  };
}

const approval = {
  kind: "approval",
  approvalId: "apr_1",
  tenantId: "tnt_1",
  runId: "run_1",
  deploymentId: "dep_1",
  toolName: "send_invoice",
  toolArguments: { amount: 4200, to: "Acme" },
  recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
  createdAt: "2026-08-08T10:00:00.000Z",
} as const;

describe("deliverNotification", () => {
  test("writes one mail per recipient, keyed on the approval itself", async () => {
    const { mail, written } = recordingMailbox();
    const deps = depsWith(mail);
    const report = await deliverApprovalMail(deps, {
      kind: "approval",
      approvalId: approval.approvalId,
      tenantId: approval.tenantId,
      runId: approval.runId,
      deploymentId: approval.deploymentId,
      toolName: approval.toolName,
      toolArguments: approval.toolArguments,
      recipients: [
        { tenantId: "tnt_1", principalId: "prn_1" },
        { tenantId: "tnt_1", principalId: "prn_2" },
      ],
      createdAt: approval.createdAt,
    });

    expect(report.deliveredMailboxRowIds).toEqual(["mail-1", "mail-2"]);
    expect(written).toHaveLength(2);
    expect(written[0]?.source).toBe(NOTIFY_MAIL_SOURCE);
    expect(written[0]?.externalId).toBe("apr_1");
    expect(written[0]?.address).toBe("prn_1@bench.invalid");
    expect(written[1]?.address).toBe("prn_2@bench.invalid");
    expect(written[0]?.subject).toContain("send_invoice");
    expect(written[0]?.subject).not.toContain("apr_1");
    expect(written[0]?.refs).toContainEqual({ kind: "approval", id: "apr_1" });
  });

  test("queues nothing when a recipient already had this mail", async () => {
    const deps = depsWith(dedupingMailbox());
    const report = await deliverNotification(deps, approval);
    expect(report.deliveredMailboxRowIds).toEqual([]);
    expect(report.queuedDispatchCount).toBe(0);
  });

  test("refuses an event that does not parse instead of writing mail", async () => {
    const { mail, written } = recordingMailbox();
    const deps = depsWith(mail);
    await expect(
      deliverNotification(deps, {
        kind: "approval",
        approvalId: "",
        tenantId: "tnt_1",
        runId: "run_1",
        deploymentId: "dep_1",
        toolName: "x",
        toolArguments: {},
        recipients: [],
        createdAt: "2026-08-08T10:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidNotificationEventError);
    expect(written).toHaveLength(0);
  });

  test("queues one dispatch row per enabled sink and none for a disabled one", async () => {
    const { mail } = recordingMailbox();
    const dispatch = createInMemoryNotifyDispatchStore();
    const sinks = createSinkRegistry();
    const delivered: SinkDeliveryResult = { status: "delivered" };
    sinks.register({
      name: "always",
      isEnabledFor: async () => true,
      deliver: async () => delivered,
    });
    sinks.register({
      name: "never",
      isEnabledFor: async () => false,
      deliver: async () => delivered,
    });

    const report = await deliverNotification(
      { mail, addressing, dispatch, sinks },
      approval,
    );

    expect(report.queuedDispatchCount).toBe(1);
    const rows = await dispatch.listFor("mail-1");
    expect(rows.map((row) => row.sinkName)).toEqual(["always"]);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.id.startsWith("sig_")).toBe(true);
  });

  test("run failures and mentions read as plain sentences about named things", async () => {
    const { mail, written } = recordingMailbox();
    const deps = depsWith(mail);
    await deliverRunFailureMail(deps, {
      kind: "run-failure",
      tenantId: "tnt_1",
      runId: "run_9",
      deploymentId: "dep_9",
      runLabel: "Nightly digest",
      error: "upstream timed out",
      recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
      createdAt: "2026-08-08T11:00:00.000Z",
    });
    await deliverMentionMail(deps, {
      kind: "mention",
      tenantId: "tnt_1",
      threadId: "thr_3",
      threadLabel: "Launch plan",
      mentionedBy: "Noor",
      excerpt: "can you take this one?",
      recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
      createdAt: "2026-08-08T12:00:00.000Z",
    });

    expect(written[0]?.subject).toBe("“Nightly digest” failed");
    expect(written[0]?.externalId).toBe("run_9:2026-08-08T11:00:00.000Z");
    expect(written[1]?.subject).toBe("Noor mentioned you in “Launch plan”");
    for (const item of written) {
      expect(item.subject).not.toContain("_");
    }
  });

  test("a credential-expired event mails a reconnect nudge naming the durable PAT alternative", async () => {
    const { mail, written } = recordingMailbox();
    const deps = depsWith(mail);
    await deliverCredentialMail(deps, {
      kind: "credential-expired",
      tenantId: "tnt_1",
      credentialId: "cred_hf_1",
      providerId: "huggingface",
      providerLabel: "Hugging Face",
      recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
      createdAt: "2026-08-13T09:00:00.000Z",
    });

    expect(written[0]?.subject).toBe(
      "Reconnect Hugging Face — your token expired",
    );
    expect(written[0]?.body).toContain("personal access token");
    expect(written[0]?.externalId).toBe("cred_hf_1");
    expect(written[0]?.refs).toContainEqual({
      kind: "credential",
      id: "cred_hf_1",
    });
  });

  test("a task-result event mails the reply, elapsed time, and artifact refs", async () => {
    const { mail, written } = recordingMailbox();
    const deps = depsWith(mail);
    await deliverTaskResultMail(deps, {
      kind: "task-result",
      tenantId: "tnt_1",
      taskId: "task_1",
      runId: "run_1",
      agentName: "Incident Summarizer",
      status: "done",
      replyText: "All clear, no action needed.",
      elapsedMs: 192_000,
      artifacts: [{ id: "art_1", title: "Postmortem draft" }],
      recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
      createdAt: "2026-08-14T10:00:00.000Z",
    });

    expect(written[0]?.subject).toBe(
      "“Incident Summarizer” finished your task",
    );
    expect(written[0]?.body).toContain("All clear, no action needed.");
    expect(written[0]?.body).toContain("3m 12s");
    expect(written[0]?.body).toContain("Postmortem draft");
    expect(written[0]?.externalId).toBe("task-result:task_1");
    expect(written[0]?.refs).toContainEqual({ kind: "task", id: "task_1" });
    expect(written[0]?.refs).toContainEqual({ kind: "run", id: "run_1" });
    expect(written[0]?.refs).toContainEqual({
      kind: "artifact",
      id: "art_1",
      label: "Postmortem draft",
    });
  });

  test("a failed task-result event mails the error, never a placeholder", async () => {
    const { mail, written } = recordingMailbox();
    const deps = depsWith(mail);
    await deliverTaskResultMail(deps, {
      kind: "task-result",
      tenantId: "tnt_1",
      taskId: "task_2",
      runId: "run_2",
      agentName: "Incident Summarizer",
      status: "failed",
      errorMessage: "tool call exploded",
      elapsedMs: 4_000,
      artifacts: [],
      recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
      createdAt: "2026-08-14T10:05:00.000Z",
    });

    expect(written[0]?.subject).toBe("“Incident Summarizer” failed your task");
    expect(written[0]?.body).toContain("tool call exploded");
    expect(written[0]?.body).not.toContain("Artifacts:");
  });

  test("re-notifying the same still-expired credential dedupes on the credential, not the tick", async () => {
    const dispatch = createInMemoryNotifyDispatchStore();
    const sinks = createSinkRegistry();
    const seen = new Set<string>();
    const mail: MailboxDelivery = async (items, opts) =>
      items.map((item) => {
        if (seen.has(item.externalId)) {
          return { messageKey: item.externalId, id: null };
        }
        seen.add(item.externalId);
        const id = `mail-${item.externalId}`;
        opts?.enqueue?.({ id, item });
        return { messageKey: item.externalId, id };
      });

    const first = await deliverCredentialMail(
      { mail, addressing, dispatch, sinks },
      {
        kind: "credential-expired",
        tenantId: "tnt_1",
        credentialId: "cred_hf_1",
        providerId: "huggingface",
        providerLabel: "Hugging Face",
        recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
        createdAt: "2026-08-13T09:00:00.000Z",
      },
    );
    const second = await deliverCredentialMail(
      { mail, addressing, dispatch, sinks },
      {
        kind: "credential-expired",
        tenantId: "tnt_1",
        credentialId: "cred_hf_1",
        providerId: "huggingface",
        providerLabel: "Hugging Face",
        // A later sweep tick, same still-unfixed credential.
        recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
        createdAt: "2026-08-13T09:30:00.000Z",
      },
    );

    expect(first.deliveredMailboxRowIds).toEqual(["mail-cred_hf_1"]);
    expect(second.deliveredMailboxRowIds).toEqual([]);
  });
});
