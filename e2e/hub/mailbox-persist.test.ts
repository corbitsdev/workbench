// DB-gated: skipped when DATABASE_URL is unreachable, matching every other
// suite in this directory (`composition.test.ts` boots the whole hub over
// HTTP; this suite exercises `persistMail` wiring directly, without a boot).
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDB } from "@intx/db";
import { principal, tenant as tenantTable, workflowDefinition, workflowRun } from "@intx/db/schema";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxPersist,
  principalMail,
  type MailboxDb,
} from "@corbits/mailbox";
import { createHubMailboxAuthorizeSender } from "../../apps/hub/src/mailbox-persist";
import { e2eDatabaseUrl } from "../lib/database-url";
import { dbGate } from "../lib/db-gate";
import { cleanupTenants } from "../lib/tenant-cleanup";

const databaseUrl = e2eDatabaseUrl() ?? "";
const describeIfDb = dbGate(databaseUrl, import.meta.path);

function dbConfigFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

const closers: (() => Promise<void>)[] = [];
const seededTenantIds: string[] = [];
afterAll(async () => {
  for (const close of closers) await close();
  await cleanupTenants(seededTenantIds);
});

function uid(label: string): string {
  return `${label}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * A fresh (tenant, definition, sender run, two human principals) fixture per
 * call -- every test gets its own scope, including its own mail domain (the
 * tenant table's `domain` column is globally unique), so the suite's tests
 * can run independently without colliding on shared ids.
 */
async function setup() {
  const { db, close: closeDb } = createDB(dbConfigFromUrl(databaseUrl));
  closers.push(closeDb);
  const { db: mailboxDb, close: closeMailbox } = createMailboxDb(databaseUrl) as {
    db: MailboxDb;
    close: () => Promise<void>;
  };
  closers.push(closeMailbox);

  const domain = `${uid("mailbox-persist-wrap")}.test`;
  const tenantId = uid("tnt_mbxpw");
  seededTenantIds.push(tenantId);
  const definitionId = uid("wfd_mbxpw");
  const senderRunId = uid("run_mbxpw_sender");
  const senderAddress = `${senderRunId}@${domain}`;
  const agentRecipientAddress = `${uid("run_mbxpw_recipient")}@${domain}`;
  const senderPrincipalId = uid("prn_mbxpw_sender");
  const human1Id = uid("mbxpw_h1");
  const human2Id = uid("mbxpw_h2");

  await db.insert(tenantTable).values({
    id: tenantId,
    name: "Mailbox Persist Wrap Tenant",
    slug: uid("mbxpw").replaceAll("_", "-"),
    domain,
  });
  await db.insert(workflowDefinition).values({
    id: definitionId,
    tenantId,
    name: "mailbox-persist-wrap-definition",
    status: "deployed",
  });
  await db.insert(principal).values([
    {
      id: senderPrincipalId,
      tenantId,
      kind: "workflow",
      refId: senderRunId,
      status: "active",
    },
    {
      id: human1Id,
      tenantId,
      kind: "user",
      refId: human1Id,
      status: "active",
    },
    {
      id: human2Id,
      tenantId,
      kind: "user",
      refId: human2Id,
      status: "active",
    },
  ]);
  await db.insert(workflowRun).values({
    id: senderRunId,
    anchorRunId: senderRunId,
    definitionId,
    tenantId,
    principalId: senderPrincipalId,
    status: "running",
    address: senderAddress,
  });

  return {
    db,
    mailboxDb,
    domain,
    tenantId,
    senderAddress,
    agentRecipientAddress,
    human1Id,
    human2Id,
  };
}

describeIfDb("hub persistMail wrapped with createMailboxPersist", () => {
  test("an outbound frame to two humans and one agent produces exactly two principal_mail rows and an SSE event per mailbox", async () => {
    const {
      db,
      mailboxDb,
      domain,
      tenantId,
      senderAddress,
      agentRecipientAddress,
      human1Id,
      human2Id,
    } = await setup();

    const mailboxBus = createInMemoryMailboxEventBus();
    const seenPrincipalIds = new Set<string>();
    mailboxBus.subscribe({ tenantId, principalId: human1Id }, () => {
      seenPrincipalIds.add(human1Id);
    });
    mailboxBus.subscribe({ tenantId, principalId: human2Id }, () => {
      seenPrincipalIds.add(human2Id);
    });

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: async () => [],
      authorizeSender: createHubMailboxAuthorizeSender(db),
      bus: mailboxBus,
    });

    const raw = new TextEncoder().encode(
      [
        `From: ${senderAddress}`,
        `To: usr_${human1Id}@${domain}, usr_${human2Id}@${domain}, ${agentRecipientAddress}`,
        "Subject: Turn finished",
        "",
        "Body",
      ].join("\r\n"),
    );

    const upstreamResult = await persistMail({
      senderAddress,
      recipients: [`usr_${human1Id}@${domain}`, `usr_${human2Id}@${domain}`, agentRecipientAddress],
      raw,
    });

    expect(upstreamResult).toEqual([]);

    // Exactly two durable mailbox rows -- one per human -- never one for
    // the agent recipient (a run address is never a mailbox).
    const rows = await mailboxDb
      .select()
      .from(principalMail)
      .where(eq(principalMail.tenantId, tenantId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.principalId).sort()).toEqual([human1Id, human2Id].sort());

    // Every SSE subscriber fired.
    expect(seenPrincipalIds).toEqual(new Set([human1Id, human2Id]));
  });

  test("redelivery of the same frame is deduped: a retried persist for the same message and recipient writes no second mailbox row", async () => {
    const { db, mailboxDb, domain, tenantId, senderAddress, human1Id } = await setup();

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: async () => [],
      authorizeSender: createHubMailboxAuthorizeSender(db),
    });

    const raw = new TextEncoder().encode(
      [
        `From: ${senderAddress}`,
        `To: usr_${human1Id}@${domain}`,
        "Message-ID: <redelivery-test@mbxpw.test>",
        "Subject: Redelivered",
        "",
        "Body",
      ].join("\r\n"),
    );

    await persistMail({
      senderAddress,
      recipients: [`usr_${human1Id}@${domain}`],
      raw,
    });
    await persistMail({
      senderAddress,
      recipients: [`usr_${human1Id}@${domain}`],
      raw,
    });

    const rows = await mailboxDb
      .select()
      .from(principalMail)
      .where(eq(principalMail.tenantId, tenantId));
    expect(rows).toHaveLength(1);
  });

  test("authorizeSender resolves a live sender run to its tenant and mail domain", async () => {
    const { db, domain, tenantId, senderAddress } = await setup();
    const authorizeSender = createHubMailboxAuthorizeSender(db);

    expect(await authorizeSender(senderAddress)).toEqual({
      tenantId,
      domain,
    });
  });

  test("authorizeSender refuses a sender with no live endpoint", async () => {
    const { db, domain } = await setup();
    const authorizeSender = createHubMailboxAuthorizeSender(db);

    expect(await authorizeSender(`run_no_such_run@${domain}`)).toBeNull();
  });
});
