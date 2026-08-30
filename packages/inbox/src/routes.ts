// Product inbox routes over `@corbits/mailbox`. The three groups, mark-all-
// read (mentions + deliveries only), and clear-done live here — the package
// itself stays group-agnostic.

import {
  decodeMailboxListCursor,
  enrichMailboxMessage,
  getMailboxMessage,
  listUserMailbox,
  markMailboxMessageRead,
  markMailboxMessageUnread,
  trashMailboxMessage,
  type MailboxDb,
  type MailboxEventBus,
  type MailboxEventOp,
  type MailboxFilter,
  type MailboxListCursor,
} from "@corbits/mailbox";

import { reportError } from "@corbits/error-sink";
import type { TenantEnv } from "@intx/hub-api";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import { Hono, type Context } from "hono";

import {
  itemsEligibleForClearDone,
  itemsEligibleForMarkAllRead,
  runBulkOperation,
} from "./bulk";
import { cursorScopeMismatch } from "./cursor";
import { isInboxGroup, type InboxGroup } from "./group";
import {
  projectInboxItem,
  projectInboxItemDetail,
  type InboxCounts,
  type InboxItem,
} from "./project";
import { setSnoozeUntil } from "./snooze-store";
import { WORKBENCH_INBOX_PRIORITIES } from "./vocabulary";
import { walkAllOpen } from "./walk";

// Parsed at the boundary, per AGENTS.md: `until` is untrusted request
// input, never `as`-cast. Required — a snooze with no `until` is exactly
// the bug this ticket fixes (CL-7208).
const SnoozeBodySchema = type({ until: "string" });

/** Thrown inside `/:id/snooze`'s transaction to roll back a snooze-until
 * insert for a message that turned out not to be in scope, and caught
 * outside to answer 404 instead of a 500. */
class SnoozeTargetNotFound extends Error {}

// Page size for bulk product ops (mark-all-read, clear-done, counts). Large
// enough that a normal inbox finishes in one round-trip; anything past it
// walks with the package's cursor.
const BULK_PAGE_LIMIT = 100;

const publishLog = getLogger(["inbox", "publish"]);

export interface CreateInboxRoutesDeps {
  db: MailboxDb;
  bus: MailboxEventBus;
}

function publish(
  bus: MailboxEventBus,
  scope: { tenantId: string; principalId: string },
  id: string,
  op: MailboxEventOp,
): void {
  // `publishMailboxEvent` is package-internal and not re-exported; hosts
  // publish through the bus surface with the same best-effort contract.
  try {
    bus.publish(scope, { type: "mailbox", id, op });
  } catch (error) {
    publishLog.error(
      "mailbox event publish failed for {id} ({op}) on tenant {tenantId}, principal {principalId}: {error}",
      {
        id,
        op,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function listAllOpen(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
  filter?: MailboxFilter,
): Promise<InboxItem[]> {
  return walkAllOpen((page) => {
    const listOpts = {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      // "all" = not trashed, not archived — the product's open inbox.
      view: "all" as const,
      limit: BULK_PAGE_LIMIT,
      priorities: WORKBENCH_INBOX_PRIORITIES,
    };
    const listOptsWithCursor =
      page.cursor !== undefined
        ? { ...listOpts, cursor: page.cursor }
        : listOpts;
    return listUserMailbox(
      db,
      filter !== undefined
        ? { ...listOptsWithCursor, filter }
        : listOptsWithCursor,
    );
  });
}

/**
 * Tenant-scoped product inbox. Mount under
 * `/api/tenants/:tenantId/inbox` inside the hub's tenant middleware so
 * `c.get("principal")` and `c.get("tenant")` are already resolved.
 */
export function createInboxRoutes(
  deps: CreateInboxRoutesDeps,
): Hono<TenantEnv> {
  const { db, bus } = deps;
  const app = new Hono<TenantEnv>();

  // A failed inbox walk (an undecodable cursor mid-walk, a cursor that
  // never advances, or a pathologically large inbox — see walk.ts) must be
  // loud, not a silently truncated count or bulk op. Reported through
  // @corbits/error-sink and answered as a 500 with the refId a person can
  // quote back, rather than a falsely-complete 200 (CL-7207).
  async function listAllOpenOrReport(
    c: Context<TenantEnv>,
    tenantId: string,
    operation: string,
    scope: { tenantId: string; principalId: string },
    filter?: MailboxFilter,
  ): Promise<InboxItem[] | Response> {
    try {
      return await listAllOpen(db, scope, filter);
    } catch (cause) {
      const refId = reportError(cause, { operation, tenantId });
      return c.json({ error: "could not list the inbox", refId }, 500);
    }
  }

  // Static path segments first so `/:id` never captures them.
  app.get("/counts", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const items = await listAllOpenOrReport(c, tenant.id, "inbox_counts_walk", {
      tenantId: tenant.id,
      principalId: principal.id,
    });
    if (items instanceof Response) return items;
    const counts: InboxCounts = {
      action: 0,
      mention: 0,
      delivery: 0,
      open: 0,
    };
    for (const item of items) {
      if (item.status !== "open") continue;
      counts[item.group] += 1;
      counts.open += 1;
    }
    return c.json(counts);
  });

  app.post("/mark-all-read", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const scope = { tenantId: tenant.id, principalId: principal.id };
    const items = await listAllOpenOrReport(
      c,
      tenant.id,
      "inbox_mark_all_read_walk",
      scope,
    );
    if (items instanceof Response) return items;
    const { succeeded: marked, failed } = await runBulkOperation(
      itemsEligibleForMarkAllRead(items),
      async (item) => {
        // Atomic: a throw between the status flip and the read flip must
        // never leave a row done-but-unread (CL-7207).
        await db.transaction(async (tx) => {
          await enrichMailboxMessage(
            tx,
            { ...scope, id: item.id },
            { status: "done" },
          );
          await markMailboxMessageRead(tx, { ...scope, id: item.id });
        });
        publish(bus, scope, item.id, "mark_read");
      },
      (item, error) =>
        reportError(error, {
          operation: "inbox_mark_all_read_item",
          tenantId: tenant.id,
          extra: { id: item.id },
        }),
    );
    // A 200 must mean "every eligible item was marked" — a partial result
    // is reported as 207 so a caller that only checks the status code (not
    // the body) can't mistake "half the inbox" for "success" (CL-7207).
    return c.json(
      { marked, failed, complete: failed === 0 },
      failed === 0 ? 200 : 207,
    );
  });

  app.post("/clear-done", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const scope = { tenantId: tenant.id, principalId: principal.id };
    const items = await listAllOpenOrReport(
      c,
      tenant.id,
      "inbox_clear_done_walk",
      scope,
    );
    if (items instanceof Response) return items;
    const { succeeded: cleared, failed } = await runBulkOperation(
      itemsEligibleForClearDone(items),
      async (item) => {
        const ok = await trashMailboxMessage(db, { ...scope, id: item.id });
        if (!ok) throw new Error(`message ${item.id} not found to trash`);
        publish(bus, scope, item.id, "trash");
      },
      (item, error) =>
        reportError(error, {
          operation: "inbox_clear_done_item",
          tenantId: tenant.id,
          extra: { id: item.id },
        }),
    );
    // Same partial-vs-complete signal as mark-all-read: 207 whenever any
    // item failed, so a status-code-only caller can't read it as success.
    return c.json(
      { cleared, failed, complete: failed === 0 },
      failed === 0 ? 200 : 207,
    );
  });

  app.get("/", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const groupParam = c.req.query("group");
    const statusParam = c.req.query("status");
    const limitRaw = c.req.query("limit");
    const rawCursor = c.req.query("cursor");

    let group: InboxGroup | undefined;
    if (groupParam !== undefined) {
      if (!isInboxGroup(groupParam)) {
        return c.json({ error: "invalid group" }, 400);
      }
      group = groupParam;
    }

    let limit = 50;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > BULK_PAGE_LIMIT) {
        return c.json({ error: "invalid limit" }, 400);
      }
      limit = parsed;
    }

    const filter: MailboxFilter = {};
    if (group !== undefined) filter.classification = group;
    if (
      statusParam === "open" ||
      statusParam === "done" ||
      statusParam === "snoozed"
    ) {
      filter.status = statusParam;
    }

    let cursor: MailboxListCursor | undefined;
    if (rawCursor !== undefined) {
      const decoded = decodeMailboxListCursor(rawCursor);
      if (decoded === null) {
        return c.json({ error: "malformed cursor" }, 400);
      }
      // A cursor is only meaningful against the exact view/sort/filter it
      // was minted under (CL-7206) — paging `?group=action` then replaying
      // that cursor under `?group=mention` must be rejected, not silently
      // seek into the wrong result set. Same error vocabulary as
      // `@corbits/mailbox`'s own `mount.ts` cross-check.
      const mismatch = cursorScopeMismatch(decoded, {
        view: "all",
        sort: "date",
        filter,
      });
      if (mismatch !== null) {
        return c.json(
          { error: `cursor does not match inbox ${mismatch}` },
          400,
        );
      }
      cursor = decoded;
    }

    const listMailboxOpts = {
      tenantId: tenant.id,
      principalId: principal.id,
      view: "all" as const,
      sort: "date" as const,
      limit,
      priorities: WORKBENCH_INBOX_PRIORITIES,
    };
    const listMailboxOptsWithCursor =
      cursor !== undefined ? { ...listMailboxOpts, cursor } : listMailboxOpts;
    const page = await listUserMailbox(
      db,
      Object.keys(filter).length > 0
        ? { ...listMailboxOptsWithCursor, filter }
        : listMailboxOptsWithCursor,
    );

    return c.json({
      items: page.items.map(projectInboxItem),
      nextCursor: page.nextCursor,
    });
  });

  app.get("/:id", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const id = c.req.param("id");
    const message = await getMailboxMessage(db, {
      tenantId: tenant.id,
      principalId: principal.id,
      id,
    });
    if (message === null) return c.json({ error: "not found" }, 404);
    return c.json(projectInboxItemDetail(message));
  });

  app.post("/:id/read", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const id = c.req.param("id");
    const ok = await markMailboxMessageRead(db, {
      tenantId: tenant.id,
      principalId: principal.id,
      id,
    });
    if (!ok) return c.json({ error: "not found" }, 404);
    publish(
      bus,
      { tenantId: tenant.id, principalId: principal.id },
      id,
      "mark_read",
    );
    return c.json({ ok: true });
  });

  app.post("/:id/unread", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const id = c.req.param("id");
    const ok = await markMailboxMessageUnread(db, {
      tenantId: tenant.id,
      principalId: principal.id,
      id,
    });
    if (!ok) return c.json({ error: "not found" }, 404);
    publish(
      bus,
      { tenantId: tenant.id, principalId: principal.id },
      id,
      "mark_unread",
    );
    return c.json({ ok: true });
  });

  app.post("/:id/done", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const id = c.req.param("id");
    const scope = {
      tenantId: tenant.id,
      principalId: principal.id,
      id,
    };
    const ok = await enrichMailboxMessage(db, scope, { status: "done" });
    if (!ok) return c.json({ error: "not found" }, 404);
    await markMailboxMessageRead(db, scope);
    publish(
      bus,
      { tenantId: tenant.id, principalId: principal.id },
      id,
      "enrich",
    );
    return c.json({ ok: true });
  });

  app.post("/:id/snooze", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const id = c.req.param("id");
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsedBody = SnoozeBodySchema(rawBody);
    if (parsedBody instanceof type.errors) {
      return c.json(
        { error: `invalid snooze body: ${parsedBody.summary}` },
        400,
      );
    }
    const until = new Date(parsedBody.until);
    if (Number.isNaN(until.getTime())) {
      return c.json({ error: "until must be a valid timestamp" }, 400);
    }
    const now = new Date();
    if (until.getTime() <= now.getTime()) {
      return c.json({ error: "until must be in the future" }, 400);
    }

    const scope = { tenantId: tenant.id, principalId: principal.id, id };
    // Both writes run in one transaction: an uncommitted insert is
    // invisible to any other transaction under read-committed isolation,
    // so the sweep's own `claimAndReopenSnooze` can never see this snooze
    // row until the status flip has *also* committed alongside it. Without
    // this, a sweep tick landing between two separate statements could
    // find the row before the status flip lands, no-op (the message isn't
    // `snoozed` yet) and delete the row as "cleanup," and then the status
    // flip would still land afterward — leaving the message stuck
    // `snoozed` with the row that was supposed to reopen it already gone.
    // That is exactly this ticket's bug, reintroduced by an un-transacted
    // write order (CL-7208). Throwing (rather than returning false) on a
    // missing message rolls the snooze insert back too, via the sentinel
    // below caught outside the transaction.
    let notFound = false;
    await db
      .transaction(async (tx) => {
        await setSnoozeUntil(tx, scope, until);
        const ok = await enrichMailboxMessage(tx, scope, { status: "snoozed" });
        if (!ok) throw new SnoozeTargetNotFound();
      })
      .catch((error) => {
        if (error instanceof SnoozeTargetNotFound) {
          notFound = true;
          return;
        }
        throw error;
      });
    if (notFound) {
      return c.json({ error: "not found" }, 404);
    }
    publish(
      bus,
      { tenantId: tenant.id, principalId: principal.id },
      id,
      "enrich",
    );
    return c.json({
      ok: true,
      until: until.toISOString(),
    });
  });

  app.post("/:id/reopen", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const id = c.req.param("id");
    const ok = await enrichMailboxMessage(
      db,
      { tenantId: tenant.id, principalId: principal.id, id },
      { status: "open" },
    );
    if (!ok) return c.json({ error: "not found" }, 404);
    publish(
      bus,
      { tenantId: tenant.id, principalId: principal.id },
      id,
      "enrich",
    );
    return c.json({ ok: true });
  });

  return app;
}
