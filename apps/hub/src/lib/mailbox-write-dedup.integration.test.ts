import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import { schema } from "../db";
import type { HubDb } from "../db";
import { principalMailbox } from "../db/schema";
import { writeMailboxMessage } from "./mailbox-write";

// Integration coverage for the durable dedup contract of writeMailboxMessage
// (CL-3517 review). The terminal-run and gate mail deliverers rely on the
// (tenant, principal, messageKey) UNIQUE index to make a re-projected pack a
// no-op — the mailbox never grows a duplicate inbox item. This exercises the
// REAL write against a real (PGlite) Postgres with the production partial unique
// index, not a mocked insert: only the real DB proves onConflictDoNothing +
// the partial index actually collapse the second write.

// The production partial unique index over (tenant_id, principal_id,
// message_key) WHERE message_key IS NOT NULL — mirrored from schema.ts so the
// conflict target the write names actually exists here.
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
    refs jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    read_at timestamp
  );
  CREATE UNIQUE INDEX principal_mailbox_message_key_uniq
    ON principal_mailbox (tenant_id, principal_id, message_key)
    WHERE message_key IS NOT NULL;
`;

let client: PGlite;
let db: HubDb;

const ARGS = {
  tenantId: "ten-1",
  principalId: "prn-alice",
  address: "usr_alice@tenant.example",
  fromAddress: "hub@wf.example",
  subject: "Workflow run failed: Demo",
  body: "The run failed.",
  messageKey: "run:wfr-1:failed",
};

beforeEach(async () => {
  client = new PGlite();
  await client.exec(PRINCIPAL_MAILBOX_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
});

async function countRows(): Promise<number> {
  return (
    await db
      .select({ id: principalMailbox.id })
      .from(principalMailbox)
      .where(eq(principalMailbox.messageKey, ARGS.messageKey))
  ).length;
}

describe("writeMailboxMessage — durable dedup seam", () => {
  test("a second write with the same messageKey is a no-op returning null", async () => {
    const first = await writeMailboxMessage(db, ARGS);
    expect(first).not.toBeNull();

    const second = await writeMailboxMessage(db, ARGS);
    expect(second).toBeNull();

    expect(await countRows()).toBe(1);
  });

  test("distinct messageKeys for the same recipient both persist", async () => {
    await writeMailboxMessage(db, ARGS);
    await writeMailboxMessage(db, {
      ...ARGS,
      messageKey: "run:wfr-1:completed",
    });

    const rows = await db
      .select({ id: principalMailbox.id })
      .from(principalMailbox);
    expect(rows).toHaveLength(2);
  });
});
