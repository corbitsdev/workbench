// CL-7449: proves the real composition -- `createHubSessionLookups`'s
// `persistMail` wrapped by `createMailboxPersist` via
// `createHubMailboxAuthorizeSender` / `createHubMailboxRowRefsStamper`
// (`../src/mailbox-persist.ts`) -- against a real Postgres, matching how
// `createHub` wires them in `../src/index.ts`. DB-gated: skipped when
// DATABASE_URL is unreachable, matching every other suite in this
// directory (see `composition.test.ts`).
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDB } from "@intx/db";
import {
  agentSession,
  principal,
  tenant as tenantTable,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxPersist,
  principalMail,
  type MailboxDb,
} from "@corbits/mailbox";
import {
  createHubSessionLookups,
  type AgentRepoStore,
} from "@intx/hub-sessions";

import {
  createHubMailboxAuthorizeSender,
  createHubMailboxRowRefsStamper,
} from "../src/mailbox-persist";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
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
afterAll(async () => {
  for (const close of closers) await close();
});

const DOMAIN = "mailbox-persist-wrap.test";

function uid(label: string): string {
  return `${label}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * A fresh (tenant, definition, sender run + session, two human principals)
 * fixture per call -- every test gets its own scope so the suite's tests can
 * run independently without colliding on shared ids.
 */
async function setup() {
  const { db, close: closeDb } = createDB(dbConfigFromUrl(databaseUrl));
  closers.push(closeDb);
  const { db: mailboxDb, close: closeMailbox } = createMailboxDb(
    databaseUrl,
  ) as { db: MailboxDb; close: () => Promise<void> };
  closers.push(closeMailbox);

  const tenantId = uid("tnt_mbxpw");
  const definitionId = uid("wfd_mbxpw");
  const senderRunId = uid("run_mbxpw_sender");
  const senderAddress = `${senderRunId}@${DOMAIN}`;
  const agentRecipientAddress = `${uid("run_mbxpw_recipient")}@${DOMAIN}`;
  const senderPrincipalId = uid("prn_mbxpw_sender");
  const human1Id = uid("mbxpw_h1");
  const human2Id = uid("mbxpw_h2");
  const sessionId = uid("ses_mbxpw");

  await db.insert(tenantTable).values({
    id: tenantId,
    name: "Mailbox Persist Wrap Tenant",
    slug: uid("mbxpw"),
    domain: DOMAIN,
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
  await db.insert(agentSession).values({
    id: sessionId,
    tenantId,
    agentId: definitionId,
    principalId: senderPrincipalId,
    status: "active",
  });

  return {
    db,
    mailboxDb,
    tenantId,
    senderAddress,
    agentRecipientAddress,
    human1Id,
    human2Id,
  };
}

describeIfDb("hub persistMail wrapped with createMailboxPersist", () => {
  test("an outbound frame to two humans and one agent produces exactly two principal_mail rows, an SSE event per mailbox, and still runs the upstream session_mail write", async () => {
    const {
      db,
      mailboxDb,
      tenantId,
      senderAddress,
      agentRecipientAddress,
      human1Id,
      human2Id,
    } = await setup();

    const baseLookups = createHubSessionLookups({
      db,
      // persistMail (the only lookup this suite exercises) never touches
      // agentRepoStore -- unlike the pack-receive lookups -- so an
      // unimplemented stand-in is safe here.
      agentRepoStore: undefined as unknown as AgentRepoStore,
    });

    const mailboxBus = createInMemoryMailboxEventBus();
    const seenPrincipalIds: string[] = [];
    mailboxBus.subscribe({ tenantId, principalId: human1Id }, () =>
      seenPrincipalIds.push(human1Id),
    );
    mailboxBus.subscribe({ tenantId, principalId: human2Id }, () =>
      seenPrincipalIds.push(human2Id),
    );

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: baseLookups.persistMail,
      authorizeSender: createHubMailboxAuthorizeSender(db),
      bus: mailboxBus,
      onRow: createHubMailboxRowRefsStamper(mailboxDb),
    });

    const raw = new TextEncoder().encode(
      [
        `From: ${senderAddress}`,
        `To: usr_${human1Id}@${DOMAIN}, usr_${human2Id}@${DOMAIN}, ${agentRecipientAddress}`,
        "Subject: Turn finished",
        "",
        "Body",
      ].join("\r\n"),
    );

    const upstreamResult = await persistMail({
      senderAddress,
      recipients: [
        `usr_${human1Id}@${DOMAIN}`,
        `usr_${human2Id}@${DOMAIN}`,
        agentRecipientAddress,
      ],
      raw,
    });

    // The upstream `session_mail` write still ran: one outbound record on
    // the sender's own session.
    expect(
      upstreamResult.some(
        (r) => r.direction === "outbound" && r.address === senderAddress,
      ),
    ).toBe(true);

    // Exactly two durable mailbox rows -- one per human -- never one for
    // the agent recipient (a run address is never a mailbox).
    const rows = await mailboxDb
      .select()
      .from(principalMail)
      .where(eq(principalMail.tenantId, tenantId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.principalId).sort()).toEqual(
      [human1Id, human2Id].sort(),
    );

    // The onRow hook stamped the workbench ref onto both rows.
    for (const row of rows) {
      expect(row.refs).toEqual([{ kind: "workbench", id: tenantId }]);
    }

    // One SSE event per mailbox.
    expect(seenPrincipalIds.sort()).toEqual([human1Id, human2Id].sort());
  });

  test("authorizeSender resolves a live sender run to its tenant and mail domain", async () => {
    const { db, tenantId, senderAddress } = await setup();
    const authorizeSender = createHubMailboxAuthorizeSender(db);

    expect(await authorizeSender(senderAddress)).toEqual({
      tenantId,
      domain: DOMAIN,
    });
  });

  test("authorizeSender refuses a sender with no live endpoint", async () => {
    const { db } = await setup();
    const authorizeSender = createHubMailboxAuthorizeSender(db);

    expect(await authorizeSender(`run_no_such_run@${DOMAIN}`)).toBeNull();
  });
});
