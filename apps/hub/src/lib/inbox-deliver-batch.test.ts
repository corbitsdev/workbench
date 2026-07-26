import { describe, expect, mock, test } from "bun:test";
import type { HubDb } from "../db";

const artifactCalls: unknown[] = [];
const mailCalls: unknown[] = [];

// Per-test overrides so a single delivery can be made to fail deep inside the
// artifact/mail writers without the others failing — the property this batch
// exists to guarantee.
let artifactThrowsFor: string | null = null;
let mailReturnsNullFor: string | null = null;
// The tenant's real membership, keyed refId → principal id. A refId absent here
// is a departed member: the skip-with-reason path.
let knownRefIds: Record<string, string> = {};

mock.module("../tools/write-artifact", () => ({
  writeArtifactDeduped: async (args: unknown) => {
    artifactCalls.push(args);
    const { sourceRef } = args as { sourceRef?: string };
    if (artifactThrowsFor !== null && sourceRef === artifactThrowsFor) {
      throw new Error("artifact store unavailable");
    }
    return { artifactId: "art_1", version: 1 };
  },
}));

mock.module("./mailbox-write", () => ({
  writeMailboxMessage: async (_db: HubDb, args: unknown) => {
    mailCalls.push(args);
    const { messageKey } = args as { messageKey?: string };
    if (mailReturnsNullFor !== null && messageKey === mailReturnsNullFor) {
      return null;
    }
    return { id: "mail_1" };
  },
}));

mock.module("./tenant-member-routing", () => ({
  resolvePrincipalIdsByRefId: async (
    _db: HubDb,
    _tenantId: string,
    refIds: readonly string[],
  ) =>
    new Map(
      refIds
        .filter((refId) => knownRefIds[refId] !== undefined)
        .map((refId) => [refId, knownRefIds[refId] as string]),
    ),
}));

const { deliverInboxBatch } = await import("./inbox-deliver-batch");

function resetBatchMocks(): void {
  artifactCalls.length = 0;
  mailCalls.length = 0;
  artifactThrowsFor = null;
  mailReturnsNullFor = null;
  knownRefIds = { alex: "prn_alex", pontus: "prn_pontus", sam: "prn_sam" };
}

function draft(refId: string) {
  return {
    refId,
    subject: `LinkedIn draft — ${refId}`,
    body: "Draft body",
    messageKey: `linkedin-daily-mail:${refId}:2026-07-24`,
    artifact: {
      title: `LinkedIn draft — ${refId}`,
      body: "Draft body",
      kind: "linkedin-daily-draft",
      sourceRef: `linkedin-daily:${refId}:2026-07-24`,
      jobLabel: "daily-linkedin",
    },
  };
}

function batchArgs(refIds: string[]) {
  return {
    tenantId: "ten_1",
    actorPrincipalId: "prn_actor",
    fromLocalPart: "daily-linkedin",
    userAddress: "usr_owner@workbench.example",
    deliveries: refIds.map(draft),
  };
}

describe("deliverInboxBatch", () => {
  test("routes by refId: writes the artifact owned by that member, then mails them", async () => {
    resetBatchMocks();
    const result = await deliverInboxBatch({} as HubDb, batchArgs(["alex"]));

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0]?.refId).toBe("alex");
    expect(result.delivered[0]?.principalId).toBe("prn_alex");
    expect(result.delivered[0]?.address).toBe("usr_alex@workbench.example");
    expect(result.delivered[0]?.mailWritten).toBe(true);
    expect(result.delivered[0]?.artifactId).toBe("art_1");

    // The artifact is written BY the run's actor but OWNED by the recipient —
    // otherwise every draft lands in the schedule owner's workbench.
    const art = artifactCalls[0] as {
      sourceRef: string;
      principalId: string;
      ownerPrincipalId: string;
    };
    expect(art.sourceRef).toBe("linkedin-daily:alex:2026-07-24");
    expect(art.principalId).toBe("prn_actor");
    expect(art.ownerPrincipalId).toBe("prn_alex");

    const mail = mailCalls[0] as {
      messageKey: string;
      fromAddress: string;
      address: string;
      principalId: string;
    };
    expect(mail.messageKey).toBe("linkedin-daily-mail:alex:2026-07-24");
    expect(mail.fromAddress).toBe("daily-linkedin@workbench.example");
    expect(mail.address).toBe("usr_alex@workbench.example");
    expect(mail.principalId).toBe("prn_alex");
  });

  // CL-4429's accepted tradeoff: the stored selection is a snapshot, so a
  // departed member leaves a dead refId behind. That must be SKIPPED with a
  // reason — not silently dropped (their drafts would stop with nobody
  // noticing) and not fatal (the rest of the team still gets theirs).
  test("a departed member's refId is skipped with a reason, and the rest still deliver", async () => {
    resetBatchMocks();
    delete knownRefIds.pontus;

    const result = await deliverInboxBatch(
      {} as HubDb,
      batchArgs(["alex", "pontus", "sam"]),
    );

    expect(result.delivered.map((d) => d.refId)).toEqual(["alex", "sam"]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.refId).toBe("pontus");
    expect(result.skipped[0]?.reason).toMatch(/no active member/);
    expect(result.skipped[0]?.reason).toMatch(/edit the schedule/);

    // A skipped recipient gets neither an artifact nor mail.
    expect(
      (mailCalls as { principalId: string }[]).map((m) => m.principalId),
    ).toEqual(["prn_alex", "prn_sam"]);
    expect(
      (artifactCalls as { ownerPrincipalId: string }[]).map(
        (a) => a.ownerPrincipalId,
      ),
    ).toEqual(["prn_alex", "prn_sam"]);
  });

  test("a batch where every recipient has departed resolves with skips and no errors", async () => {
    resetBatchMocks();
    knownRefIds = {};
    const result = await deliverInboxBatch(
      {} as HubDb,
      batchArgs(["alex", "pontus"]),
    );
    expect(result.delivered).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipped.map((s) => s.refId)).toEqual(["alex", "pontus"]);
    expect(mailCalls).toHaveLength(0);
  });

  // The tolerance direction that matters at run time: this is a fan-out over N
  // people, so one recipient's failure must be recorded and stepped over, never
  // allowed to abort the batch and leave the rest of the roster undelivered.
  test("isolates a failing delivery: the rest still deliver, the failure is reported", async () => {
    resetBatchMocks();
    artifactThrowsFor = "linkedin-daily:pontus:2026-07-24";

    const result = await deliverInboxBatch(
      {} as HubDb,
      batchArgs(["alex", "pontus", "sam"]),
    );

    expect(result.delivered.map((d) => d.refId)).toEqual(["alex", "sam"]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([
      { refId: "pontus", error: "artifact store unavailable" },
    ]);
    expect(
      (mailCalls as { principalId: string }[]).map((m) => m.principalId),
    ).toEqual(["prn_alex", "prn_sam"]);
  });

  test("a batch where every delivery fails still resolves — it never throws", async () => {
    resetBatchMocks();
    artifactThrowsFor = "linkedin-daily:alex:2026-07-24";
    const result = await deliverInboxBatch({} as HubDb, batchArgs(["alex"]));
    expect(result.delivered).toEqual([]);
    expect(result.errors).toEqual([
      { refId: "alex", error: "artifact store unavailable" },
    ]);
    expect(mailCalls).toHaveLength(0);
  });

  // The re-run contract: a same-day repeat re-writes the artifact under the
  // same sourceRef but must NOT re-mail. `writeMailboxMessage` returns null on
  // a messageKey conflict; that is a delivered row with mailWritten false.
  test("a repeat messageKey reports mailWritten false, not an error", async () => {
    resetBatchMocks();
    mailReturnsNullFor = "linkedin-daily-mail:alex:2026-07-24";
    const result = await deliverInboxBatch({} as HubDb, batchArgs(["alex"]));
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.delivered[0]?.mailWritten).toBe(false);
    expect(result.delivered[0]?.artifactId).toBe("art_1");
  });

  test("a blank refId is reported as an error, not thrown", async () => {
    resetBatchMocks();
    const result = await deliverInboxBatch({} as HubDb, {
      ...batchArgs(["alex"]),
      deliveries: [{ ...draft("alex"), refId: "  " }],
    });
    expect(result.delivered).toEqual([]);
    expect(result.errors[0]?.error).toMatch(/refId/);
  });

  test("rejects an artifact with a blank sourceRef", async () => {
    resetBatchMocks();
    const bad = draft("alex");
    const result = await deliverInboxBatch({} as HubDb, {
      ...batchArgs(["alex"]),
      deliveries: [{ ...bad, artifact: { ...bad.artifact, sourceRef: "" } }],
    });
    expect(result.errors[0]?.error).toMatch(/sourceRef/);
  });

  test("a malformed userAddress fails the whole call — there is no domain to mail into", async () => {
    resetBatchMocks();
    await expect(
      deliverInboxBatch({} as HubDb, {
        ...batchArgs(["alex"]),
        userAddress: "not-an-address",
      }),
    ).rejects.toThrow(/userAddress/);
  });
});
