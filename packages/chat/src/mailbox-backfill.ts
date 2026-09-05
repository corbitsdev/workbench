// Backfills every workbench message posted before CL-7450 into every human
// participant's `@corbits/mailbox` inbox (CL-7454). CL-7450 wired the LIVE
// send path (`sendWorkbenchMessage`) to fan a new message out as it is
// posted; nothing wrote a mailbox copy of a message posted before that
// landed, and nothing retroactively fills the gap for a workbench that has
// been quiet since. This module is that fill: a replay that walks
// `workbench_messages` oldest-first, mints and stamps `mail_message_id` for
// any row that predates CL-7104, and writes the same kind of mailbox rows
// `writeChatMailboxFanout` would have written at send time — an "outbound"
// copy for a human author, an "inbound" copy for every other human, and an
// "inbound"-only copy for an agent-authored row (an agent has no mailbox of
// its own to hold an outbound copy in).
//
// Idempotent by the same default transport key `@corbits/mailbox` derives
// for a live send (`mailboxKey.transport`, keyed on the frame's own
// Message-ID, recipient, and direction): rerunning this replay against a
// workbench it has already finished writes nothing new. The per-workbench
// progress cursor (`chat.mailbox_backfill_cursor`, `./schema.ts`) is a
// courtesy on top of that — it lets a rerun skip straight past everything
// already replayed rather than re-issuing a no-op write per historical
// row — never the source of the idempotency guarantee itself.
//
// Every mailbox row this replay writes carries an extra `{ kind: "import",
// id: "chat-backfill" }` ref alongside the row's `{ kind: "workbench", id }`
// ref, so a reader (or a future migration) can tell a backfilled copy apart
// from one a live send wrote. `@corbits/mailbox`'s own per-row `priority`/
// `classification`/`status` triage columns were the other candidate for
// this marker, but they are the HOST's own vocabulary (see
// `WriteMailboxMessageArgs`'s doc comment in `@corbits/mailbox`'s
// `write.ts`) — stamping one of them here would mean minting a
// mount-boundary vocabulary value this package does not own, for a marker
// nothing downstream yet reads. The `refs` entry needs no such contract:
// `MailboxRef` is already an open `{ kind, id }` shape a reader either
// recognizes or ignores, exactly like the `workbench` ref beside it.
//
// This whole module (and its migration, `0030_mailbox_backfill_cursor`) is
// meant to be temporary: once `workbench_messages` itself is retired, there
// is nothing left to backfill from, and this module, its cursor table, and
// its boot step should all be deleted together. See docs/CHAT.md.
import { and, asc, eq, gt, or } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { reportError } from "@corbits/error-sink";
import type { MailboxRef } from "@corbits/mailbox";
import {
  humanPrincipalIds,
  mailboxBodyOf,
  mailboxSubjectOf,
  type MailboxBatchItem,
  type MailboxFanoutDeps,
} from "./mailbox-fanout";
import { mailMessageIdFor, mailThreadHeaders } from "./mail-headers";
import { mailAncestryOf, type ThreadStore } from "./threads";
import type { RoomMessage, RoomMessageStore } from "./room-messages";
import { participantsOf } from "./workbench-settings";
import { chatMailboxBackfillCursor, workbenchMessages } from "./schema";
import type { ChatDb } from "./store";

const logger = getLogger(["chat", "mailbox-backfill"]);

/** Marks a mailbox row this replay wrote, alongside its ordinary
 * `{ kind: "workbench", id }` ref — see this module's own doc comment for
 * why a `refs` entry rather than a `classification`/`status` stamp. */
export const MAILBOX_BACKFILL_IMPORT_REF: MailboxRef = {
  kind: "import",
  id: "chat-backfill",
};

const DEFAULT_PAGE_SIZE = 200;

export interface MailboxBackfillCursor {
  readonly lastMessageId: string;
  readonly lastCreatedAt: string;
}

/** The replay's own progress marker per workbench — see `./schema.ts`'s
 * `chatMailboxBackfillCursor` for the durable shape. */
export interface MailboxBackfillCursorStore {
  get(
    tenantId: string,
    workbenchId: string,
  ): Promise<MailboxBackfillCursor | undefined>;
  advance(
    tenantId: string,
    workbenchId: string,
    cursor: MailboxBackfillCursor,
  ): Promise<void>;
}

/** In-memory `MailboxBackfillCursorStore`, for tests and any host running
 * without a database. */
export function createInMemoryMailboxBackfillCursorStore(): MailboxBackfillCursorStore {
  const cursors = new Map<string, MailboxBackfillCursor>();
  const keyOf = (tenantId: string, workbenchId: string) =>
    `${tenantId}:${workbenchId}`;
  return {
    async get(tenantId, workbenchId) {
      return cursors.get(keyOf(tenantId, workbenchId));
    },
    async advance(tenantId, workbenchId, cursor) {
      cursors.set(keyOf(tenantId, workbenchId), cursor);
    },
  };
}

/**
 * The one-workbench-at-a-time, oldest-first read the replay needs — a
 * different shape than `RoomMessageStore.listMessages`'s own newest-first,
 * client-cursor-paginated feed read, so it is its own small port rather than
 * an overload bolted onto that one. `listWorkbenchesWithMessages` is the
 * replay's own sweep target list: every (tenant, workbench) pair that has
 * ever held a message, regardless of whether a human is still a
 * participant — `runMailboxBackfillPass` is what decides to skip a
 * workbench with no human participants, not this listing.
 */
export interface MailboxBackfillMessageSource {
  listWorkbenchesWithMessages(): Promise<
    readonly { readonly tenantId: string; readonly workbenchId: string }[]
  >;
  /** Strictly after `after` (exclusive), oldest first, capped at `limit`. */
  pageMessages(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly after?: MailboxBackfillCursor;
    readonly limit: number;
  }): Promise<readonly RoomMessage[]>;
}

export interface MailboxBackfillDeps {
  readonly messages: MailboxBackfillMessageSource;
  readonly roomMessages: Pick<RoomMessageStore, "stampMailMessageId">;
  readonly threads: Pick<ThreadStore, "getThread" | "threadIdForMessage">;
  readonly settings: {
    getWorkbenchSettings(
      tenantId: string,
      workbenchId: string,
    ): Promise<{ readonly settings: Record<string, unknown> } | undefined>;
  };
  readonly mailbox: MailboxFanoutDeps;
  readonly cursors: MailboxBackfillCursorStore;
  /** Defaults to 200. */
  readonly pageSize?: number;
}

export type MailboxBackfillSkipReason = "no-human-participants";

export interface MailboxBackfillWorkbenchSummary {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly replayed: number;
  readonly skipped?: MailboxBackfillSkipReason;
}

export interface MailboxBackfillSummary {
  readonly workbenches: readonly MailboxBackfillWorkbenchSummary[];
  readonly totalReplayed: number;
  /** Workbenches whose replay raised before finishing (reported, not
   * thrown) — a rerun resumes each from its own last-good cursor. */
  readonly totalFailed: number;
}

/** The mailbox batch item(s) one historical row produces: an author-aware
 * fan-out matching what `writeChatMailboxFanout` would have written at
 * send time, plus this replay's own import marker. */
function batchItemsFor(input: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly domain: string;
  readonly row: RoomMessage;
  readonly mailMessageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly candidateIds: readonly string[];
  readonly known: ReadonlySet<string>;
}): MailboxBatchItem[] {
  const body = mailboxBodyOf(input.row.parts);
  const subject = mailboxSubjectOf(body);
  const refs: MailboxRef[] = [
    { kind: "workbench", id: input.workbenchId },
    MAILBOX_BACKFILL_IMPORT_REF,
  ];
  const authorPrincipalId = input.row.senderPrincipalId;
  const items: MailboxBatchItem[] = [];

  for (const principalId of input.candidateIds) {
    if (!input.known.has(principalId)) {
      if (principalId === authorPrincipalId) {
        logger.debug(
          "backfill: author {principalId} has no principal in {tenantId}; " +
            "skipping its own mailbox copy for {messageId}",
          { principalId, tenantId: input.tenantId, messageId: input.row.id },
        );
        continue;
      }
      reportError(new Error(`no principal "${principalId}" in tenant`), {
        operation: "chat.mailboxBackfill.resolveParticipant",
        tenantId: input.tenantId,
        roomId: input.workbenchId,
        extra: { principalId, messageId: input.row.id },
      });
      continue;
    }
    const direction: "inbound" | "outbound" =
      authorPrincipalId !== null && principalId === authorPrincipalId
        ? "outbound"
        : "inbound";
    items.push({
      tenantId: input.tenantId,
      principalId,
      address: `${principalId}@${input.domain}`,
      fromAddress: input.row.sender.address,
      subject,
      body,
      messageId: input.mailMessageId,
      direction,
      refs,
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references !== undefined && input.references.length > 0
        ? { references: input.references }
        : {}),
    });
  }
  return items;
}

/**
 * Replays one historical row into every human participant's mailbox.
 * Mints and stamps the row's `mail_message_id` first when it predates
 * CL-7104 (a live send always has one by the time this replay ever sees
 * it, but a row posted before that rollout does not). Throws on a write
 * failure — already reported under its own `refId` — so the caller can
 * stop advancing this workbench's cursor past a row that never actually
 * landed.
 */
async function replayRow(
  deps: Pick<MailboxBackfillDeps, "roomMessages" | "threads" | "mailbox">,
  tenantId: string,
  workbenchId: string,
  participants: ReturnType<typeof participantsOf>,
  domain: string,
  row: RoomMessage,
): Promise<void> {
  const mailMessageId = row.mailMessageId ?? mailMessageIdFor(row.id, domain);
  if (row.mailMessageId === null) {
    await deps.roomMessages.stampMailMessageId({
      tenantId,
      workbenchId,
      messageId: row.id,
      mailMessageId,
    });
  }

  const ancestors = await mailAncestryOf(
    deps.threads,
    tenantId,
    workbenchId,
    row.threadId,
  );
  const headers = mailThreadHeaders({ rowId: row.id, domain, ancestors });

  const candidateIds = new Set(humanPrincipalIds(participants));
  if (row.senderPrincipalId !== null) candidateIds.add(row.senderPrincipalId);
  const candidateList = [...candidateIds];
  if (candidateList.length === 0) return;

  const known = await deps.mailbox.resolveKnownPrincipalIds(
    tenantId,
    candidateList,
  );
  const items = batchItemsFor({
    tenantId,
    workbenchId,
    domain,
    row,
    mailMessageId,
    ...(headers.inReplyTo !== undefined
      ? { inReplyTo: headers.inReplyTo }
      : {}),
    ...(headers.references !== undefined
      ? { references: headers.references }
      : {}),
    candidateIds: candidateList,
    known,
  });
  if (items.length === 0) return;

  try {
    await deps.mailbox.writer.writeBatch(items);
  } catch (err) {
    const refId = reportError(err, {
      operation: "chat.mailboxBackfill.write",
      tenantId,
      roomId: workbenchId,
      extra: { messageId: row.id },
    });
    throw new Error(
      `mailbox backfill write failed for ${workbenchId}/${row.id} (refId ${refId})`,
      { cause: err },
    );
  }
}

/**
 * Replays one workbench's history from its own cursor forward. Skips
 * outright — no cursor read, no page walked — a workbench with no human
 * participant at all: nobody's mailbox is waiting for these rows. A row
 * whose write fails stops this workbench's pass without advancing the
 * cursor past it, so the next pass retries from the same row rather than
 * silently skipping it forever.
 */
async function replayWorkbench(
  deps: MailboxBackfillDeps,
  tenantId: string,
  workbenchId: string,
  pageSize: number,
): Promise<{
  readonly replayed: number;
  readonly skipped?: MailboxBackfillSkipReason;
}> {
  const settingsRow = await deps.settings.getWorkbenchSettings(
    tenantId,
    workbenchId,
  );
  const participants =
    settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];
  if (humanPrincipalIds(participants).length === 0) {
    return { replayed: 0, skipped: "no-human-participants" };
  }

  const domain = await deps.mailbox.resolveTenantDomain(tenantId);
  let cursor = await deps.cursors.get(tenantId, workbenchId);
  let replayed = 0;

  for (;;) {
    const page = await deps.messages.pageMessages({
      tenantId,
      workbenchId,
      ...(cursor !== undefined ? { after: cursor } : {}),
      limit: pageSize,
    });
    if (page.length === 0) break;

    let rowFailed = false;
    for (const row of page) {
      try {
        await replayRow(deps, tenantId, workbenchId, participants, domain, row);
      } catch (err) {
        reportError(err, {
          operation: "chat.mailboxBackfill.row",
          tenantId,
          roomId: workbenchId,
          extra: { messageId: row.id },
        });
        rowFailed = true;
        break;
      }
      cursor = { lastMessageId: row.id, lastCreatedAt: row.createdAt };
      await deps.cursors.advance(tenantId, workbenchId, cursor);
      replayed += 1;
    }
    if (rowFailed || page.length < pageSize) break;
  }

  return { replayed };
}

/**
 * One backfill pass: every workbench `workbench_messages` has ever held a
 * row for, replayed from its own cursor forward. Never throws — a single
 * workbench's failure is reported and counted, and every other workbench
 * still gets its own pass — and never blocks the caller's boot path (see
 * `apps/hub/src/index.ts`'s own fire-and-forget wiring, matching the
 * relaunch sweep's own posture).
 */
export async function runMailboxBackfillPass(
  deps: MailboxBackfillDeps,
): Promise<MailboxBackfillSummary> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const workbenches = await deps.messages.listWorkbenchesWithMessages();
  const summaries: MailboxBackfillWorkbenchSummary[] = [];
  let totalReplayed = 0;
  let totalFailed = 0;

  for (const { tenantId, workbenchId } of workbenches) {
    try {
      const { replayed, skipped } = await replayWorkbench(
        deps,
        tenantId,
        workbenchId,
        pageSize,
      );
      summaries.push({
        tenantId,
        workbenchId,
        replayed,
        ...(skipped !== undefined ? { skipped } : {}),
      });
      totalReplayed += replayed;
    } catch (err) {
      totalFailed += 1;
      reportError(err, {
        operation: "chat.mailboxBackfill.workbench",
        tenantId,
        roomId: workbenchId,
      });
    }
  }

  logger.info(
    "mailbox backfill pass: {workbenchCount} workbenches, " +
      "{totalReplayed} rows replayed, {totalFailed} workbenches failed",
    { workbenchCount: workbenches.length, totalReplayed, totalFailed },
  );
  return { workbenches: summaries, totalReplayed, totalFailed };
}

interface BackfillMessageRow {
  id: string;
  workbenchId: string;
  senderAddress: string;
  senderName: string | null;
  senderPrincipalId: string | null;
  runId: string | null;
  threadId: string | null;
  mailMessageId: string | null;
  parts: unknown;
  createdAt: Date;
}

function toRoomMessage(row: BackfillMessageRow): RoomMessage {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    createdAt: row.createdAt.toISOString(),
    sender: { name: row.senderName, address: row.senderAddress },
    senderPrincipalId: row.senderPrincipalId,
    runId: row.runId,
    threadId: row.threadId,
    mailMessageId: row.mailMessageId,
    parts: row.parts as RoomMessage["parts"],
  };
}

/**
 * The production `MailboxBackfillMessageSource`: an oldest-first,
 * keyset-paginated read over `workbench_messages` — the same
 * `(created_at, id)` total order `room-messages.ts`'s own newest-first
 * cursor pages by, just walked forward instead of backward — plus the
 * distinct (tenant, workbench) listing the sweep enumerates from.
 */
export function createDrizzleMailboxBackfillMessageSource(
  db: ChatDb<Record<string, unknown>>,
): MailboxBackfillMessageSource {
  return {
    async listWorkbenchesWithMessages() {
      const rows = await db
        .selectDistinct({
          tenantId: workbenchMessages.tenantId,
          workbenchId: workbenchMessages.workbenchId,
        })
        .from(workbenchMessages);
      return rows;
    },

    async pageMessages(input) {
      const inWorkbench = and(
        eq(workbenchMessages.tenantId, input.tenantId),
        eq(workbenchMessages.workbenchId, input.workbenchId),
      );
      const after = input.after;
      const where =
        after === undefined
          ? inWorkbench
          : and(
              inWorkbench,
              or(
                and(
                  eq(
                    workbenchMessages.createdAt,
                    new Date(after.lastCreatedAt),
                  ),
                  gt(workbenchMessages.id, after.lastMessageId),
                ),
                gt(workbenchMessages.createdAt, new Date(after.lastCreatedAt)),
              ),
            );
      const rows = await db
        .select()
        .from(workbenchMessages)
        .where(where)
        .orderBy(asc(workbenchMessages.createdAt), asc(workbenchMessages.id))
        .limit(input.limit);
      return rows.map((row) => toRoomMessage(row as BackfillMessageRow));
    },
  };
}

/** The production `MailboxBackfillCursorStore`, over
 * `chat.mailbox_backfill_cursor` (`./schema.ts`). */
export function createDrizzleMailboxBackfillCursorStore(
  db: ChatDb<Record<string, unknown>>,
): MailboxBackfillCursorStore {
  return {
    async get(tenantId, workbenchId) {
      const [row] = await db
        .select()
        .from(chatMailboxBackfillCursor)
        .where(
          and(
            eq(chatMailboxBackfillCursor.tenantId, tenantId),
            eq(chatMailboxBackfillCursor.workbenchId, workbenchId),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      return {
        lastMessageId: row.lastMessageId,
        lastCreatedAt: row.lastCreatedAt.toISOString(),
      };
    },

    async advance(tenantId, workbenchId, cursor) {
      await db
        .insert(chatMailboxBackfillCursor)
        .values({
          tenantId,
          workbenchId,
          lastMessageId: cursor.lastMessageId,
          lastCreatedAt: new Date(cursor.lastCreatedAt),
        })
        .onConflictDoUpdate({
          target: [
            chatMailboxBackfillCursor.tenantId,
            chatMailboxBackfillCursor.workbenchId,
          ],
          set: {
            lastMessageId: cursor.lastMessageId,
            lastCreatedAt: new Date(cursor.lastCreatedAt),
            updatedAt: new Date(),
          },
        });
    },
  };
}
