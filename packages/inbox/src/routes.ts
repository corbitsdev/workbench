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

import type { TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import { isInboxGroup, type InboxGroup } from "./group";
import { itemsEligibleForClearDone, itemsEligibleForMarkAllRead } from "./bulk";
import {
  projectInboxItem,
  projectInboxItemDetail,
  type InboxCounts,
  type InboxItem,
} from "./project";
import { WORKBENCH_INBOX_PRIORITIES } from "./vocabulary";

// Page size for bulk product ops (mark-all-read, clear-done, counts). Large
// enough that a normal inbox finishes in one round-trip; anything past it
// walks with the package's cursor.
const BULK_PAGE_LIMIT = 100;

const publishLog = {
  error(message: string, data?: Record<string, unknown>): void {
    console.error(message, data);
  },
};

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
    publishLog.error("mailbox event publish failed", {
      id,
      op,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function listAllOpen(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
  filter?: MailboxFilter,
): Promise<InboxItem[]> {
  const out: InboxItem[] = [];
  let cursor: MailboxListCursor | undefined;
  for (;;) {
    const listOpts = {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      // "all" = not trashed, not archived — the product's open inbox.
      view: "all" as const,
      limit: BULK_PAGE_LIMIT,
      priorities: WORKBENCH_INBOX_PRIORITIES,
    };
    const listOptsWithCursor =
      cursor !== undefined ? { ...listOpts, cursor } : listOpts;
    const page = await listUserMailbox(
      db,
      filter !== undefined
        ? { ...listOptsWithCursor, filter }
        : listOptsWithCursor,
    );
    for (const message of page.items) {
      out.push(projectInboxItem(message));
    }
    if (page.nextCursor === undefined) break;
    const next = decodeMailboxListCursor(page.nextCursor);
    if (next === null) break;
    cursor = next;
  }

  return out;
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

  // Static path segments first so `/:id` never captures them.
  app.get("/counts", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const items = await listAllOpen(db, {
      tenantId: tenant.id,
      principalId: principal.id,
    });
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
    const items = await listAllOpen(db, scope);
    let marked = 0;
    for (const item of itemsEligibleForMarkAllRead(items)) {
      await enrichMailboxMessage(
        db,
        { ...scope, id: item.id },
        { status: "done" },
      );
      await markMailboxMessageRead(db, { ...scope, id: item.id });
      publish(bus, scope, item.id, "mark_read");
      marked += 1;
    }
    return c.json({ marked });
  });

  app.post("/clear-done", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const scope = { tenantId: tenant.id, principalId: principal.id };
    const items = await listAllOpen(db, scope);
    let cleared = 0;
    for (const item of itemsEligibleForClearDone(items)) {
      const ok = await trashMailboxMessage(db, { ...scope, id: item.id });
      if (ok) {
        publish(bus, scope, item.id, "trash");
        cleared += 1;
      }
    }
    return c.json({ cleared });
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
      cursor = decoded;
    }

    const listMailboxOpts = {
      tenantId: tenant.id,
      principalId: principal.id,
      view: "all" as const,
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
    const body: unknown = await c.req.json().catch(() => ({}));
    // `until` is accepted for forward-compat with a scheduled unsnooze; the
    // product store today only records the status flip.
    let until: string | undefined;
    if (typeof body === "object" && body !== null && "until" in body) {
      const rawUntil = (body as { until: unknown }).until;
      if (rawUntil !== undefined && typeof rawUntil !== "string") {
        return c.json({ error: "until must be a string" }, 400);
      }
      if (typeof rawUntil === "string") until = rawUntil;
    }
    const ok = await enrichMailboxMessage(
      db,
      { tenantId: tenant.id, principalId: principal.id, id },
      { status: "snoozed" },
    );
    if (!ok) return c.json({ error: "not found" }, 404);
    publish(
      bus,
      { tenantId: tenant.id, principalId: principal.id },
      id,
      "enrich",
    );
    return c.json({
      ok: true,
      until,
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
