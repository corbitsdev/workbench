// CL-7450: a sent human message lands in every human participant's
// mailbox — an "outbound" copy in the sender's own, "inbound" in every
// other human's — all sharing the row's own RFC 5322 Message-ID, and the
// same idempotency key makes a retried send a no-op rather than a
// duplicate. Exercised against an in-memory `MailboxWriter`, never a
// live `@corbits/mailbox` schema — see `../src/mailbox-fanout.ts`'s own
// doc comment for why the write is behind that seam.
import { describe, expect, test } from "bun:test";
import {
  writeChatMailboxFanout,
  mailboxBodyOf,
  mailboxSubjectOf,
  type MailboxWriteArgs,
  type MailboxWriter,
} from "../src/mailbox-fanout";
import type { ParticipantRecord } from "../src/participants";
import { sendWorkbenchMessage } from "../src/workbench-service";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryChatStore } from "../src/store";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createTurnCancelRegistry } from "../src/turn-cancellation";

type Recorded = MailboxWriteArgs & { direction: "inbound" | "outbound" };

function inMemoryWriter(): { writer: MailboxWriter; rows: Recorded[] } {
  const rows: Recorded[] = [];
  const seen = new Set<string>();
  function keyOf(args: MailboxWriteArgs): string {
    return `${args.tenantId}:${args.principalId}:${args.messageKey}`;
  }
  function write(
    direction: "inbound" | "outbound",
    args: MailboxWriteArgs,
  ): { id: string } | null {
    const key = keyOf(args);
    if (seen.has(key)) return null;
    seen.add(key);
    const id = `mail_${String(rows.length + 1)}`;
    rows.push({ ...args, direction });
    return { id };
  }
  return {
    rows,
    writer: {
      async writeInbound(args) {
        return write("inbound", args);
      },
      async writeOutbound(args) {
        return write("outbound", args);
      },
    },
  };
}

function knownPrincipals(ids: readonly string[]) {
  const known = new Set(ids);
  return async (
    _tenantId: string,
    candidateIds: readonly string[],
  ): Promise<ReadonlySet<string>> =>
    new Set(candidateIds.filter((id) => known.has(id)));
}

const TENANT_ID = "tnt_1";
const WORKBENCH_ID = "wb_1";
const DOMAIN = "acme.example";
const SENDER = "prn_alice";
const OTHER_HUMANS = ["prn_bob", "prn_carol"];
const AGENT_ADDRESS = "ins_echo1@acme.example";

function participantsOf(
  senderId: string,
  humanIds: readonly string[],
  agentAddress: string,
): ParticipantRecord[] {
  return [
    { address: senderId, handle: senderId },
    ...humanIds.map((id) => ({ address: id, handle: id })),
    { address: agentAddress, handle: "echo" },
  ];
}

describe("writeChatMailboxFanout (CL-7450)", () => {
  test("a send to a three-human, one-agent workbench yields three mailbox writes sharing one Message-ID", async () => {
    const { writer, rows } = inMemoryWriter();
    const senderAddress = `${SENDER}@${DOMAIN}`;

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, ...OTHER_HUMANS]),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, OTHER_HUMANS, AGENT_ADDRESS),
        messageId: "<msg_1@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    expect(rows).toHaveLength(3);
    const messageIds = new Set(rows.map((row) => row.messageKey));
    expect(messageIds).toEqual(new Set(["<msg_1@acme.example>"]));

    const byPrincipal = new Map(rows.map((row) => [row.principalId, row]));
    expect(byPrincipal.get(SENDER)?.direction).toBe("outbound");
    expect(byPrincipal.get("prn_bob")?.direction).toBe("inbound");
    expect(byPrincipal.get("prn_carol")?.direction).toBe("inbound");

    // The agent never gets a mailbox row — its inbox is its run's own
    // mail queue, dispatched separately through `WorkbenchMail.sendMail`.
    expect(byPrincipal.has(AGENT_ADDRESS)).toBe(false);

    for (const row of rows) {
      expect(row.refs).toEqual([{ kind: "workbench", id: WORKBENCH_ID }]);
    }
  });

  test("a retried send is idempotent on messageKey", async () => {
    const { writer, rows } = inMemoryWriter();
    const senderAddress = `${SENDER}@${DOMAIN}`;
    const input = {
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      senderAddress,
      senderPrincipalId: SENDER,
      participants: participantsOf(SENDER, OTHER_HUMANS, AGENT_ADDRESS),
      messageId: "<msg_2@acme.example>",
      subject: "hello",
      body: "hello",
    };
    const deps = {
      writer,
      resolveKnownPrincipalIds: knownPrincipals([SENDER, ...OTHER_HUMANS]),
    };

    await writeChatMailboxFanout(deps, input);
    await writeChatMailboxFanout(deps, input);

    expect(rows).toHaveLength(3);
  });

  test("skips a participant address with no known principal, reporting rather than writing", async () => {
    const { writer, rows } = inMemoryWriter();
    const senderAddress = `${SENDER}@${DOMAIN}`;

    await writeChatMailboxFanout(
      {
        writer,
        // "prn_bob" is a participant, but not a known tenant principal —
        // a stale or removed member.
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_carol"]),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, OTHER_HUMANS, AGENT_ADDRESS),
        messageId: "<msg_3@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    const principalIds = rows.map((row) => row.principalId);
    expect(principalIds).toContain(SENDER);
    expect(principalIds).toContain("prn_carol");
    expect(principalIds).not.toContain("prn_bob");
  });

  test("propagates a write failure rather than swallowing it", async () => {
    const failing: MailboxWriter = {
      async writeInbound() {
        throw new Error("db exploded");
      },
      async writeOutbound(args) {
        return { id: `out_${args.principalId}` };
      },
    };

    await expect(
      writeChatMailboxFanout(
        {
          writer: failing,
          resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
        },
        {
          tenantId: TENANT_ID,
          workbenchId: WORKBENCH_ID,
          senderAddress: `${SENDER}@${DOMAIN}`,
          senderPrincipalId: SENDER,
          participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
          messageId: "<msg_4@acme.example>",
          subject: "hello",
          body: "hello",
        },
      ),
    ).rejects.toThrow("db exploded");
  });

  test("inReplyTo threads through to every recipient's write", async () => {
    const { writer, rows } = inMemoryWriter();

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress: `${SENDER}@${DOMAIN}`,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
        messageId: "<msg_6@acme.example>",
        inReplyTo: "<msg_5@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    for (const row of rows) {
      expect(row.inReplyTo).toBe("<msg_5@acme.example>");
    }
  });
});

describe("sendWorkbenchMessage's mailbox fan-out wiring (CL-7450)", () => {
  test("posting a message stamps the row's mail Message-ID and fans it into every human participant's mailbox", async () => {
    const { writer, rows } = inMemoryWriter();
    const store = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const claims = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    const turnQueue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });
    const turnCancellation = createTurnCancelRegistry();

    await store.createWorkbenchSettings({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      updatedBy: SENDER,
      settings: {
        "chat/participants": participantsOf(
          SENDER,
          OTHER_HUMANS,
          AGENT_ADDRESS,
        ),
      },
    });

    const result = await sendWorkbenchMessage(
      {
        store,
        roomMessages,
        publish: () => undefined,
        platform: {
          async sendMail() {
            return { id: "mail_agent_1", createdAt: new Date().toISOString() };
          },
        },
        turnQueue,
        turnCancellation,
        mailbox: {
          writer,
          resolveKnownPrincipalIds: knownPrincipals([
            SENDER,
            ...OTHER_HUMANS,
          ]),
        },
      },
      {
        tenantId: TENANT_ID,
        principalId: SENDER,
        senderAddress: `${SENDER}@${DOMAIN}`,
        workbenchId: WORKBENCH_ID,
        messageParts: [{ kind: "text", text: "hello everyone" }],
      },
    );
    await result.fanoutDelivered;

    const stored = await roomMessages.getMessage({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      messageId: result.id,
    });
    expect(stored?.mailMessageId).toBe(`<${result.id}@${DOMAIN}>`);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.messageKey).toBe(`<${result.id}@${DOMAIN}>`);
    }
  });
});

describe("mailboxBodyOf / mailboxSubjectOf", () => {
  test("joins text parts and clips the subject to the first line", () => {
    const body = mailboxBodyOf([
      { kind: "text", text: "line one" },
      { kind: "event" },
      { kind: "text", text: "line two" },
    ]);
    expect(body).toBe("line one\n\nline two");
    expect(mailboxSubjectOf(body)).toBe("line one");
  });

  test("a bodyless message gets a placeholder subject", () => {
    expect(mailboxSubjectOf("")).toBe("(no subject)");
  });
});
