import { describe, expect, test } from "bun:test";

import {
  createApprovalNotificationBridge,
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  type MailboxDelivery,
  type NotifyAddressing,
  type NotifyInboxItem,
  type ParkedApproval,
} from "../src/index";

const addressing: NotifyAddressing = {
  inbox: (recipient) => `${recipient.principalId}@bench.invalid`,
  from: (kind) => `${kind}@notify.invalid`,
};

const parked: ParkedApproval = {
  approvalId: "apr_7",
  tenantId: "tnt_1",
  runId: "run_1",
  deploymentId: "dep_1",
  toolName: "post_to_slack",
  toolArguments: { channel: "#general" },
  createdAt: new Date("2026-08-08T09:00:00.000Z"),
};

function bridgeOver(
  findParkedApproval: (id: string) => Promise<ParkedApproval | null>,
  approvers: { tenantId: string; principalId: string }[],
): { run: (id: string) => Promise<void>; written: NotifyInboxItem[] } {
  const written: NotifyInboxItem[] = [];
  const seen = new Set<string>();
  const mail: MailboxDelivery = async (items, opts) =>
    items.map((item) => {
      const deduped = seen.has(item.externalId + item.principalId);
      seen.add(item.externalId + item.principalId);
      if (deduped) return { messageKey: item.externalId, id: null };
      written.push(item);
      const id = `mail-${written.length}`;
      opts?.enqueue?.({ id, item });
      return { messageKey: item.externalId, id };
    });
  const run = createApprovalNotificationBridge({
    delivery: {
      mail,
      addressing,
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    },
    findParkedApproval,
    listApprovers: async () => approvers,
  });
  return { run, written };
}

describe("createApprovalNotificationBridge", () => {
  test("mails every approver once, even when the register frame is redelivered", async () => {
    const { run, written } = bridgeOver(
      async () => parked,
      [
        { tenantId: "tnt_1", principalId: "prn_1" },
        { tenantId: "tnt_1", principalId: "prn_2" },
      ],
    );
    await run("cor_1");
    await run("cor_1");
    expect(written).toHaveLength(2);
    expect(written.map((item) => item.principalId)).toEqual(["prn_1", "prn_2"]);
    expect(written[0]?.externalId).toBe("apr_7");
    expect(written[0]?.subject).toBe("Approve “post_to_slack”?");
  });

  test("mails nobody when the correlation has no approval", async () => {
    const { run, written } = bridgeOver(
      async () => null,
      [{ tenantId: "tnt_1", principalId: "prn_1" }],
    );
    await run("cor_missing");
    expect(written).toHaveLength(0);
  });

  test("mails nobody when no one can resolve the approval", async () => {
    const { run, written } = bridgeOver(async () => parked, []);
    await run("cor_1");
    expect(written).toHaveLength(0);
  });
});
