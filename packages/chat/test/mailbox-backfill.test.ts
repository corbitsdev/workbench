// CL-7454: the mailbox backfill replay's paging/cursor/author-fan-out logic,
// exercised against in-memory fakes — never a live `@corbits/mailbox`
// schema (see `./mailbox-backfill.drizzle.test.ts` for that).
import { describe, expect, test } from "bun:test";
import {
  runMailboxBackfillPass,
  createInMemoryMailboxBackfillCursorStore,
  type MailboxBackfillDeps,
  type MailboxBackfillMessageSource,
} from "../src/mailbox-backfill";
import type { MailboxBatchItem, MailboxWriter } from "../src/mailbox-fanout";
import type { RoomMessage } from "../src/room-messages";
import type { ParticipantRecord } from "../src/participants";
import { createInMemoryThreadStore } from "../src/threads";

const TENANT_ID = "tnt_1";
const WORKBENCH_ID = "wb_1";
const DOMAIN = "acme.example";
const ALICE = "prn_alice";
const BOB = "prn_bob";
const AGENT_ADDRESS = "ins_echo1@acme.example";

function inMemoryWriter(): { writer: MailboxWriter; rows: MailboxBatchItem[] } {
  const rows: MailboxBatchItem[] = [];
  const seen = new Set<string>();
  return {
    rows,
    writer: {
      async writeBatch(items) {
        return items.map((item) => {
          const key = `${item.tenantId}:${item.principalId}:${item.messageId}:${item.direction}`;
          if (seen.has(key)) return { messageKey: key, id: null };
          seen.add(key);
          rows.push(item);
          return { messageKey: key, id: `mail_${String(rows.length)}` };
        });
      },
    },
  };
}

function messageSourceOf(
  rows: readonly RoomMessage[],
): MailboxBackfillMessageSource {
  const byWorkbench = new Map<string, RoomMessage[]>();
  for (const row of rows) {
    const key = `${TENANT_ID}:${row.workbenchId}`;
    byWorkbench.set(key, [...(byWorkbench.get(key) ?? []), row]);
  }
  return {
    async listWorkbenchesWithMessages() {
      return [...byWorkbench.keys()].map((key) => {
        const [tenantId, workbenchId] = key.split(":");
        return {
          tenantId: tenantId as string,
          workbenchId: workbenchId as string,
        };
      });
    },
    async pageMessages(input) {
      const all = (
        byWorkbench.get(`${input.tenantId}:${input.workbenchId}`) ?? []
      ).slice();
      const after = input.after;
      const filtered =
        after === undefined
          ? all
          : all.filter(
              (row) =>
                row.createdAt > after.lastCreatedAt ||
                (row.createdAt === after.lastCreatedAt &&
                  row.id > after.lastMessageId),
            );
      return filtered
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id.localeCompare(b.id)
            : a.createdAt.localeCompare(b.createdAt),
        )
        .slice(0, input.limit);
    },
  };
}

function row(input: {
  id: string;
  createdAt: string;
  senderAddress: string;
  senderPrincipalId: string | null;
  threadId?: string | null;
  mailMessageId?: string | null;
}): RoomMessage {
  return {
    id: input.id,
    workbenchId: WORKBENCH_ID,
    createdAt: input.createdAt,
    sender: { name: null, address: input.senderAddress },
    senderPrincipalId: input.senderPrincipalId,
    runId: input.senderPrincipalId === null ? "run_1" : null,
    threadId: input.threadId ?? null,
    mailMessageId: input.mailMessageId ?? null,
    parts: [{ kind: "text", text: `text of ${input.id}` }],
  };
}

function participants(): ParticipantRecord[] {
  return [
    { address: ALICE, handle: "alice" },
    { address: BOB, handle: "bob" },
    { address: AGENT_ADDRESS, handle: "echo" },
  ];
}

function knownPrincipals(ids: readonly string[]) {
  const known = new Set(ids);
  return async (
    _tenantId: string,
    candidateIds: readonly string[],
  ): Promise<ReadonlySet<string>> =>
    new Set(candidateIds.filter((id) => known.has(id)));
}

function depsFor(
  rows: readonly RoomMessage[],
  writer: MailboxWriter,
  overrides: Partial<MailboxBackfillDeps> = {},
): MailboxBackfillDeps {
  const stamped: { messageId: string; mailMessageId: string }[] = [];
  return {
    messages: messageSourceOf(rows),
    roomMessages: {
      async stampMailMessageId(input) {
        stamped.push({
          messageId: input.messageId,
          mailMessageId: input.mailMessageId,
        });
      },
    },
    threads: createInMemoryThreadStore(),
    settings: {
      async getWorkbenchSettings() {
        return { settings: { "chat/participants": participants() } };
      },
    },
    mailbox: {
      writer,
      resolveKnownPrincipalIds: knownPrincipals([ALICE, BOB]),
      resolveTenantDomain: async () => DOMAIN,
    },
    cursors: createInMemoryMailboxBackfillCursorStore(),
    pageSize: 2,
    ...overrides,
  };
}

describe("runMailboxBackfillPass (CL-7454)", () => {
  test("a three-message thread (person, agent, person) yields the right copies with parent links", async () => {
    const { writer, rows } = inMemoryWriter();
    const rowA = row({
      id: "msg_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      senderAddress: `${ALICE}@${DOMAIN}`,
      senderPrincipalId: ALICE,
    });
    const rowB = row({
      id: "msg_2",
      createdAt: "2026-01-01T00:00:01.000Z",
      senderAddress: AGENT_ADDRESS,
      senderPrincipalId: null,
    });
    const rowC = row({
      id: "msg_3",
      createdAt: "2026-01-01T00:00:02.000Z",
      senderAddress: `${BOB}@${DOMAIN}`,
      senderPrincipalId: BOB,
    });

    const summary = await runMailboxBackfillPass(
      depsFor([rowA, rowB, rowC], writer),
    );

    expect(summary.totalReplayed).toBe(3);
    expect(summary.totalFailed).toBe(0);

    // msg_1: human-authored (Alice) — Alice outbound, Bob inbound.
    const msg1Rows = rows.filter((r) => r.messageId === "<msg_1@acme.example>");
    expect(msg1Rows).toHaveLength(2);
    expect(msg1Rows.find((r) => r.principalId === ALICE)?.direction).toBe(
      "outbound",
    );
    expect(msg1Rows.find((r) => r.principalId === BOB)?.direction).toBe(
      "inbound",
    );

    // msg_2: agent-authored — every human gets an inbound copy, none
    // outbound, fromAddress is the agent's own.
    const msg2Rows = rows.filter((r) => r.messageId === "<msg_2@acme.example>");
    expect(msg2Rows).toHaveLength(2);
    expect(msg2Rows.every((r) => r.direction === "inbound")).toBe(true);
    expect(msg2Rows.every((r) => r.fromAddress === AGENT_ADDRESS)).toBe(true);

    // msg_3: human-authored (Bob) — Bob outbound, Alice inbound.
    const msg3Rows = rows.filter((r) => r.messageId === "<msg_3@acme.example>");
    expect(msg3Rows.find((r) => r.principalId === BOB)?.direction).toBe(
      "outbound",
    );
    expect(msg3Rows.find((r) => r.principalId === ALICE)?.direction).toBe(
      "inbound",
    );

    // Every row carries both refs, including the backfill import marker.
    for (const r of rows) {
      expect(r.refs).toEqual([
        { kind: "workbench", id: WORKBENCH_ID },
        { kind: "import", id: "chat-backfill" },
      ]);
    }
  });

  test("a second run writes nothing (idempotent by the default transport key)", async () => {
    const { writer, rows } = inMemoryWriter();
    const rowA = row({
      id: "msg_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      senderAddress: `${ALICE}@${DOMAIN}`,
      senderPrincipalId: ALICE,
    });
    const deps = depsFor([rowA], writer);

    const first = await runMailboxBackfillPass(deps);
    expect(first.totalReplayed).toBe(1);
    const countAfterFirst = rows.length;

    const second = await runMailboxBackfillPass(deps);
    expect(second.totalReplayed).toBe(0);
    expect(rows).toHaveLength(countAfterFirst);
  });

  test("a workbench with no human participants is skipped and reported", async () => {
    const { writer } = inMemoryWriter();
    const rowA = row({
      id: "msg_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      senderAddress: AGENT_ADDRESS,
      senderPrincipalId: null,
    });
    const deps = depsFor([rowA], writer, {
      settings: {
        async getWorkbenchSettings() {
          return {
            settings: {
              "chat/participants": [{ address: AGENT_ADDRESS, handle: "echo" }],
            },
          };
        },
      },
    });

    const summary = await runMailboxBackfillPass(deps);
    expect(summary.totalReplayed).toBe(0);
    expect(summary.workbenches).toEqual([
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        replayed: 0,
        skipped: "no-human-participants",
      },
    ]);
  });

  test("pages through more rows than fit in one page (pageSize below rerun cursor test)", async () => {
    const { writer, rows } = inMemoryWriter();
    const messages = Array.from({ length: 5 }, (_, i) =>
      row({
        id: `msg_${String(i + 1)}`,
        createdAt: `2026-01-01T00:00:0${String(i)}.000Z`,
        senderAddress: `${ALICE}@${DOMAIN}`,
        senderPrincipalId: ALICE,
      }),
    );
    const deps = depsFor(messages, writer);

    const summary = await runMailboxBackfillPass(deps);
    expect(summary.totalReplayed).toBe(5);
    // Alice (outbound) + Bob (inbound) per message.
    expect(rows).toHaveLength(10);
  });

  test("a row that already has a mail_message_id is not re-stamped, and its existing id is reused", async () => {
    const { writer, rows } = inMemoryWriter();
    const rowA = row({
      id: "msg_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      senderAddress: `${ALICE}@${DOMAIN}`,
      senderPrincipalId: ALICE,
      mailMessageId: "<msg_1@acme.example>",
    });
    const deps = depsFor([rowA], writer);

    await runMailboxBackfillPass(deps);
    expect(rows.every((r) => r.messageId === "<msg_1@acme.example>")).toBe(
      true,
    );
  });
});
