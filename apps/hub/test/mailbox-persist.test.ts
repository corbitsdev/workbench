// CL-7449: proves the real composition -- `createHubSessionLookups`'s
// `persistMail` wrapped by `createMailboxPersist` via
// `createHubMailboxAuthorizeSender` / `createHubMailboxResolveRefs`
// (`../src/mailbox-persist.ts`) -- against a real Postgres, matching how
// `createHub` wires them in `../src/index.ts`. DB-gated: skipped when
// DATABASE_URL is unreachable, matching every other suite in this
// directory (`composition.test.ts` boots the whole hub over HTTP; this
// suite exercises the same `persistMail` wiring directly, without a boot).
import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDB } from "@intx/db";
import {
  agentSession,
  principal,
  sessionMail,
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
  createDrizzleChatStore,
  createDrizzleRoomMessageStore,
} from "@corbits/chat";

import {
  createHubMailboxAuthorizeSender,
  createHubMailboxResolveRefs,
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

function uid(label: string): string {
  return `${label}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * A fresh (tenant, definition, sender run, two human principals) fixture per
 * call -- every test gets its own scope, including its own mail domain (the
 * tenant table's `domain` column is globally unique), so the suite's tests
 * can run independently without colliding on shared ids.
 *
 * `withSession` (default `true`) controls whether the sender run also gets
 * a live `agent_session` row -- `hub-session-lookups.ts`'s `persistMail`
 * throws "has no session" for a sender run with none, which is exactly the
 * upstream-failure branch the dual-write-independence test below exercises.
 *
 * `workbenchIds` optionally seeds one `workbench_settings` row per entry,
 * each naming the sender address as a participant -- so
 * `findWorkbenchIdsByParticipantAddress` (and therefore the participant-scan
 * fallback inside `createHubMailboxResolveRefs`) has one or several
 * workbenches to resolve to. Omitted, the sender belongs to no workbench --
 * the plain-workflow-mail case `resolveRefs` must also handle by stamping
 * no ref.
 */
async function setup(
  opts: { withSession?: boolean; workbenchIds?: string[] } = {},
) {
  const withSession = opts.withSession ?? true;

  const { db, close: closeDb } = createDB(dbConfigFromUrl(databaseUrl));
  closers.push(closeDb);
  const { db: mailboxDb, close: closeMailbox } = createMailboxDb(
    databaseUrl,
  ) as { db: MailboxDb; close: () => Promise<void> };
  closers.push(closeMailbox);

  const domain = `${uid("mailbox-persist-wrap")}.test`;
  const tenantId = uid("tnt_mbxpw");
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
    slug: uid("mbxpw"),
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
  if (withSession) {
    await db.insert(agentSession).values({
      id: uid("ses_mbxpw"),
      tenantId,
      agentId: definitionId,
      principalId: senderPrincipalId,
      status: "active",
    });
  }

  const chatStore = createDrizzleChatStore(db);
  const roomMessages = createDrizzleRoomMessageStore(db);

  for (const workbenchId of opts.workbenchIds ?? []) {
    await chatStore.createWorkbenchSettings({
      tenantId,
      workbenchId,
      settings: {
        "chat/participants": [{ address: senderAddress, handle: "sender" }],
      },
      updatedBy: human1Id,
    });
  }

  const baseLookups = createHubSessionLookups({
    db,
    // persistMail (the only lookup this suite exercises) never touches
    // agentRepoStore -- unlike the pack-receive lookups -- so an
    // unimplemented stand-in is safe here.
    agentRepoStore: undefined as unknown as AgentRepoStore,
  });

  return {
    db,
    mailboxDb,
    chatStore,
    roomMessages,
    baseLookups,
    domain,
    tenantId,
    senderAddress,
    agentRecipientAddress,
    human1Id,
    human2Id,
  };
}

describeIfDb("hub persistMail wrapped with createMailboxPersist", () => {
  test("an outbound frame to two humans and one agent produces exactly two principal_mail rows, an SSE event per mailbox carrying the workbench ref already, and a durable session_mail row upstream", async () => {
    const workbenchId = uid("wb_mbxpw");
    const {
      db,
      mailboxDb,
      chatStore,
      roomMessages,
      baseLookups,
      domain,
      tenantId,
      senderAddress,
      agentRecipientAddress,
      human1Id,
      human2Id,
    } = await setup({ workbenchIds: [workbenchId] });

    const mailboxBus = createInMemoryMailboxEventBus();
    // Asserted INSIDE the subscriber, at event-fire time -- no polling
    // retry loop -- because `resolveRefs` runs inside the same transaction
    // `createMailboxPersist` opens for the insert, and the bus event fires
    // only after that transaction commits (see `persist.ts`'s `announce`).
    const seenRefsByPrincipalId = new Map<string, unknown>();
    const seenPromises: Promise<void>[] = [];
    async function recordSeenRefs(principalId: string): Promise<void> {
      const [row] = await mailboxDb
        .select({ refs: principalMail.refs })
        .from(principalMail)
        .where(
          and(
            eq(principalMail.tenantId, tenantId),
            eq(principalMail.principalId, principalId),
          ),
        );
      seenRefsByPrincipalId.set(principalId, row?.refs);
    }
    mailboxBus.subscribe({ tenantId, principalId: human1Id }, () => {
      seenPromises.push(recordSeenRefs(human1Id));
    });
    mailboxBus.subscribe({ tenantId, principalId: human2Id }, () => {
      seenPromises.push(recordSeenRefs(human2Id));
    });

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: baseLookups.persistMail,
      authorizeSender: createHubMailboxAuthorizeSender(db),
      bus: mailboxBus,
      resolveRefs: createHubMailboxResolveRefs(chatStore, roomMessages),
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
      recipients: [
        `usr_${human1Id}@${domain}`,
        `usr_${human2Id}@${domain}`,
        agentRecipientAddress,
      ],
      raw,
    });
    // The bus fires synchronously inside `persistMail`, but each listener's
    // own read is async -- wait for those reads, not for more elapsed time,
    // before asserting on what they saw.
    await Promise.all(seenPromises);

    // The upstream `session_mail` write still ran, and is durable -- not
    // just present in the return value.
    expect(
      upstreamResult.some(
        (r) => r.direction === "outbound" && r.address === senderAddress,
      ),
    ).toBe(true);
    const sessionMailRows = await db
      .select()
      .from(sessionMail)
      .where(eq(sessionMail.tenantId, tenantId));
    expect(sessionMailRows.some((r) => r.direction === "outbound")).toBe(true);

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
    for (const row of rows) {
      expect(row.refs).toEqual([{ kind: "workbench", id: workbenchId }]);
    }

    // Every SSE subscriber saw the ref already populated at event time.
    expect(seenRefsByPrincipalId.size).toBe(2);
    for (const refs of seenRefsByPrincipalId.values()) {
      expect(refs).toEqual([{ kind: "workbench", id: workbenchId }]);
    }
  });

  test("a sender run with no workbench participation gets mailbox rows with no ref stamped", async () => {
    const {
      db,
      mailboxDb,
      chatStore,
      roomMessages,
      baseLookups,
      domain,
      tenantId,
      senderAddress,
      human1Id,
    } = await setup();

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: baseLookups.persistMail,
      authorizeSender: createHubMailboxAuthorizeSender(db),
      resolveRefs: createHubMailboxResolveRefs(chatStore, roomMessages),
    });

    const raw = new TextEncoder().encode(
      [
        `From: ${senderAddress}`,
        `To: usr_${human1Id}@${domain}`,
        "Subject: Plain workflow mail",
        "",
        "Body",
      ].join("\r\n"),
    );
    await persistMail({
      senderAddress,
      recipients: [`usr_${human1Id}@${domain}`],
      raw,
    });

    const [row] = await mailboxDb
      .select()
      .from(principalMail)
      .where(eq(principalMail.tenantId, tenantId));
    expect(row?.refs).toBeNull();
  });

  test("header resolves to the parent row's workbench even when the agent participates in two workbenches", async () => {
    const [workbenchOne, workbenchTwo] = [uid("wb_mbxpw"), uid("wb_mbxpw")];
    const {
      mailboxDb,
      chatStore,
      roomMessages,
      baseLookups,
      db,
      domain,
      tenantId,
      senderAddress,
      human1Id,
    } = await setup({ workbenchIds: [workbenchOne, workbenchTwo] });

    const parentRow = await roomMessages.insertMessage({
      id: uid("msg_mbxpw_parent"),
      tenantId,
      workbenchId: workbenchTwo,
      sender: { address: `usr_${human1Id}@${domain}`, name: "Human" },
      parts: [{ kind: "text", text: "the row this reply answers" }],
    });
    const mailMessageId = `<${parentRow.id}@${domain}>`;
    await roomMessages.stampMailMessageId({
      tenantId,
      workbenchId: workbenchTwo,
      messageId: parentRow.id,
      mailMessageId,
    });

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: baseLookups.persistMail,
      authorizeSender: createHubMailboxAuthorizeSender(db),
      resolveRefs: createHubMailboxResolveRefs(chatStore, roomMessages),
    });

    const raw = new TextEncoder().encode(
      [
        `From: ${senderAddress}`,
        `To: usr_${human1Id}@${domain}`,
        `In-Reply-To: ${mailMessageId}`,
        "Subject: Re: the row this reply answers",
        "",
        "Body",
      ].join("\r\n"),
    );
    await persistMail({
      senderAddress,
      recipients: [`usr_${human1Id}@${domain}`],
      raw,
    });

    const [row] = await mailboxDb
      .select()
      .from(principalMail)
      .where(eq(principalMail.tenantId, tenantId));
    expect(row?.refs).toEqual([{ kind: "workbench", id: workbenchTwo }]);
  });

  test("dual-write independence: a sender run with no live session makes upstream throw, the mailbox rows still get written, and zero session_mail rows land", async () => {
    const workbenchId = uid("wb_mbxpw");
    const {
      db,
      mailboxDb,
      chatStore,
      roomMessages,
      baseLookups,
      domain,
      tenantId,
      senderAddress,
      human1Id,
    } = await setup({ withSession: false, workbenchIds: [workbenchId] });

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: baseLookups.persistMail,
      authorizeSender: createHubMailboxAuthorizeSender(db),
      resolveRefs: createHubMailboxResolveRefs(chatStore, roomMessages),
    });

    const raw = new TextEncoder().encode(
      [
        `From: ${senderAddress}`,
        `To: usr_${human1Id}@${domain}`,
        "Subject: Sessionless sender",
        "",
        "Body",
      ].join("\r\n"),
    );

    await expect(
      persistMail({
        senderAddress,
        recipients: [`usr_${human1Id}@${domain}`],
        raw,
      }),
    ).rejects.toThrow(/no session/i);

    const mailboxRows = await mailboxDb
      .select()
      .from(principalMail)
      .where(eq(principalMail.tenantId, tenantId));
    expect(mailboxRows).toHaveLength(1);
    expect(mailboxRows[0]?.refs).toEqual([
      { kind: "workbench", id: workbenchId },
    ]);

    const sessionMailRows = await db
      .select()
      .from(sessionMail)
      .where(eq(sessionMail.tenantId, tenantId));
    expect(sessionMailRows).toHaveLength(0);
  });

  test("redelivery of the same frame is deduped: a retried persist for the same message and recipient writes no second mailbox row", async () => {
    const {
      db,
      mailboxDb,
      chatStore,
      roomMessages,
      baseLookups,
      domain,
      tenantId,
      senderAddress,
      human1Id,
    } = await setup();

    const persistMail = createMailboxPersist(mailboxDb, {
      upstream: baseLookups.persistMail,
      authorizeSender: createHubMailboxAuthorizeSender(db),
      resolveRefs: createHubMailboxResolveRefs(chatStore, roomMessages),
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
