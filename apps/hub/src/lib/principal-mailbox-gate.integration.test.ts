import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { parseHeaderSection } from "@intx/mime";
import { schema } from "../db";
import type { HubDb } from "../db";
import { principalMailbox } from "../db/schema";
import { gateMailMessageKey, markGateMailboxItemRead } from "./principal-mailbox";
import { writeMailboxMessage } from "./mailbox-write";

// The dedupe (partial unique index on message_key) and the mark-read predicate
// are Postgres-level behaviors — a mocked db can't prove either. This exercises
// them against a real (PGlite) Postgres, mirroring the DDL the 0050 migration
// ships.
const PRINCIPAL_MAILBOX_DDL = `
  CREATE TABLE principal_mailbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    address text NOT NULL,
    direction text NOT NULL,
    raw bytea NOT NULL,
    subject text,
    from_address text,
    message_key text,
    created_at timestamp NOT NULL DEFAULT now(),
    read_at timestamp
  );
  CREATE UNIQUE INDEX principal_mailbox_message_key_uniq
    ON principal_mailbox (tenant_id, principal_id, message_key)
    WHERE message_key IS NOT NULL;
`;

let client: PGlite;
let db: HubDb;

function item(overrides: Partial<Parameters<typeof writeMailboxMessage>[1]>) {
  return {
    tenantId: "ten-1",
    principalId: "prn-alice",
    address: "usr_alice@tenant.example",
    fromAddress: "hub@wf.example",
    subject: "A workflow needs you: Demo",
    body: "Run: wfr-1\r\nRespond here: /insights/trace/wfr-1",
    messageKey: gateMailMessageKey("wfr-1", "approval"),
    ...overrides,
  };
}

beforeEach(async () => {
  client = new PGlite();
  await client.exec(PRINCIPAL_MAILBOX_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
});

describe("writeMailboxMessage gate dedupe", () => {
  test("writes a keyed inbound row with a parseable RFC 2822 frame", async () => {
    const wrote = await writeMailboxMessage(db, item({}));
    expect(wrote).not.toBeNull();

    const rows = await db.select().from(principalMailbox);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      tenantId: "ten-1",
      principalId: "prn-alice",
      address: "usr_alice@tenant.example",
      direction: "inbound",
      subject: "A workflow needs you: Demo",
      fromAddress: "hub@wf.example",
      messageKey: "gate:wfr-1:approval",
      readAt: null,
    });

    const { headers } = parseHeaderSection(new Uint8Array(row?.raw as Buffer));
    expect(headers.get("subject")).toBe("A workflow needs you: Demo");
    expect(headers.get("from")).toBe("hub@wf.example");
    expect(headers.get("to")).toBe("usr_alice@tenant.example");
  });

  test("dedupes a duplicate (runId, signalName): second insert is a no-op", async () => {
    expect(await writeMailboxMessage(db, item({}))).not.toBeNull();
    expect(await writeMailboxMessage(db, item({ subject: "changed" }))).toBeNull();

    const rows = await db.select().from(principalMailbox);
    expect(rows).toHaveLength(1);
    // The first write wins — the duplicate never overwrote the subject.
    expect(rows[0]?.subject).toBe("A workflow needs you: Demo");
  });

  test("a different signal on the same run writes a distinct row", async () => {
    await writeMailboxMessage(db, item({}));
    await writeMailboxMessage(
      db,
      item({ messageKey: gateMailMessageKey("wfr-1", "review") }),
    );

    const rows = await db.select().from(principalMailbox);
    expect(rows).toHaveLength(2);
  });
});

describe("markGateMailboxItemRead", () => {
  test("stamps read_at once, then is a no-op on re-accept", async () => {
    await writeMailboxMessage(db, item({}));

    await markGateMailboxItemRead(db, "wfr-1", "approval");
    const afterFirst = (await db.select().from(principalMailbox))[0]?.readAt;
    expect(afterFirst).not.toBeNull();

    await markGateMailboxItemRead(db, "wfr-1", "approval");
    const afterSecond = (await db.select().from(principalMailbox))[0]?.readAt;
    // The isNull guard means the second accept never re-stamps the timestamp.
    expect(afterSecond?.toISOString()).toBe(afterFirst?.toISOString());
  });

  test("leaves other gates' items untouched", async () => {
    await writeMailboxMessage(db, item({}));
    await writeMailboxMessage(
      db,
      item({ messageKey: gateMailMessageKey("wfr-1", "review") }),
    );

    await markGateMailboxItemRead(db, "wfr-1", "approval");

    const review = await db
      .select()
      .from(principalMailbox)
      .where(
        and(
          eq(
            principalMailbox.messageKey,
            gateMailMessageKey("wfr-1", "review"),
          ),
        ),
      );
    expect(review[0]?.readAt).toBeNull();
  });
});
