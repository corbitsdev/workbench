import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { schema } from "../db";
import type { HubDb } from "../db";
import { principalMailbox } from "../db/schema";
import {
  applyMailboxBulkAction,
  archiveMailboxMessage,
  countUnreadActiveMailbox,
  markMailboxMessageUnread,
  restoreMailboxMessage,
  trashMailboxMessage,
} from "./mailbox-mutations";

const DDL = `
  CREATE TABLE principal_mailbox (
    id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    address text NOT NULL DEFAULT 'usr@example',
    direction text NOT NULL,
    raw bytea NOT NULL DEFAULT '\\x00'::bytea,
    subject text,
    from_address text,
    message_key text,
    refs jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    archived_at timestamptz,
    trashed_at timestamptz
  );
`;

const TENANT = "ten-1";
const PRINCIPAL = "prn-alice";

let client: PGlite;
let db: HubDb;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as HubDb;
});

afterEach(async () => {
  await client.close();
});

async function seed(id: string, read = false) {
  await db.insert(principalMailbox).values({
    id,
    tenantId: TENANT,
    principalId: PRINCIPAL,
    address: "usr@example",
    direction: "inbound",
    raw: Buffer.from("raw"),
    readAt: read ? new Date() : null,
  });
}

describe("mailbox mutations", () => {
  test("folder markers affect unread count", async () => {
    const id = "00000000-0000-4000-8000-000000000010";
    await seed(id, true);

    await markMailboxMessageUnread(db, { tenantId: TENANT, principalId: PRINCIPAL, id });
    expect(await countUnreadActiveMailbox(db, { tenantId: TENANT, principalId: PRINCIPAL })).toBe(1);

    await archiveMailboxMessage(db, { tenantId: TENANT, principalId: PRINCIPAL, id });
    expect(await countUnreadActiveMailbox(db, { tenantId: TENANT, principalId: PRINCIPAL })).toBe(0);

    await restoreMailboxMessage(db, { tenantId: TENANT, principalId: PRINCIPAL, id });
    await trashMailboxMessage(db, { tenantId: TENANT, principalId: PRINCIPAL, id });
    expect(await countUnreadActiveMailbox(db, { tenantId: TENANT, principalId: PRINCIPAL })).toBe(0);
  });

  test("bulk trash updates rows", async () => {
    const a = "00000000-0000-4000-8000-000000000011";
    await seed(a, true);
    const ids = await applyMailboxBulkAction(
      db,
      { tenantId: TENANT, principalId: PRINCIPAL },
      "trash",
      [a],
    );
    expect(ids).toEqual([a]);
    const row = await db
      .select({ trashedAt: principalMailbox.trashedAt })
      .from(principalMailbox)
      .where(and(eq(principalMailbox.id, a)));
    expect(row[0]?.trashedAt).not.toBeNull();
  });

  test("archive returns false for trashed rows", async () => {
    const id = "00000000-0000-4000-8000-000000000012";
    await seed(id, true);
    await trashMailboxMessage(db, { tenantId: TENANT, principalId: PRINCIPAL, id });
    const ok = await archiveMailboxMessage(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      id,
    });
    expect(ok).toBe(false);
  });

  test("bulk archive skips trashed ids", async () => {
    const active = "00000000-0000-4000-8000-000000000013";
    const trashed = "00000000-0000-4000-8000-000000000014";
    await seed(active, true);
    await seed(trashed, true);
    await trashMailboxMessage(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      id: trashed,
    });
    const ids = await applyMailboxBulkAction(
      db,
      { tenantId: TENANT, principalId: PRINCIPAL },
      "archive",
      [active, trashed],
    );
    expect(ids).toEqual([active]);
  });

  test("mark unread does not apply to archived rows", async () => {
    const id = "00000000-0000-4000-8000-000000000015";
    await seed(id, true);
    await archiveMailboxMessage(db, { tenantId: TENANT, principalId: PRINCIPAL, id });
    const ok = await markMailboxMessageUnread(db, {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      id,
    });
    expect(ok).toBe(false);
  });
});