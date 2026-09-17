// DB-gated integration test proving CL-6002's actual outcome: once the
// platform's plus every installed package's migrations are applied through
// scripts/db-setup.ts (the hub's standard migration path), each of the four
// kinds `@corbits/notify` defines writes a real row through
// `createWorkbenchMailboxDelivery`, and that row renders back out through
// `@corbits/mailbox`'s own native store (CL-8174: the triage/priority/
// classification vocabulary this test used to assert on is gone with the
// retired product-inbox layer — a notify item is a plain mailbox message
// now, read back the same way `/me/inbox` does). Runs against its own
// scratch database, never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { and, eq, like } from "drizzle-orm";
import { createMailboxDb, openNativeMailboxStore, principalMail } from "@corbits/mailbox";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  deliverApprovalMail,
  deliverCredentialMail,
  deliverMentionMail,
  deliverRunFailureMail,
  type ApprovalNotification,
  type NotifyDeliveryDeps,
  type NotifyDispatchStore,
  type SinkDeliveryResult,
} from "@corbits/notify";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../test/database-url";
import { createResolveExistingMailIds, createWorkbenchMailboxDelivery } from "../src/delivery";
import { dbGate } from "../../../test/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_inbox_delivery_test`;
  return url.toString();
}

// Parse DATABASE_URL the same way the hub does (apps/hub/src/index.ts): an
// empty user falls through to the postgres client's OS-username default.
function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("notify delivery writes a real mailbox row for every notification kind", () => {
  const scratchUrl = scratchUrlFor(databaseUrl ?? "postgres://localhost:5432/unused");
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  const tenantId = generateId("tenant");
  const principalId = generateId("principal");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }

    // The same path the hub boots with: the platform's own migrations,
    // then every installed package's, including `@corbits/notify` and
    // `@corbits/mailbox` — the thing CL-6002 makes true.
    await setupDatabase(scratchUrl);

    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      await db.insert(schema.tenant).values({
        id: tenantId,
        name: "Delivery Test Bench",
        slug: `delivery-${tenantId}`,
        domain: `delivery-${tenantId}.localhost`,
      });
      await db.insert(schema.principal).values({
        id: principalId,
        tenantId,
        kind: "agent",
        refId: "not-a-real-agent-instance",
        status: "active",
      });
    } finally {
      await close();
    }
    // `setupDatabase` applies the platform's migrations plus every
    // installed package's (six of them); under `bun run test`'s
    // cross-package concurrency that comfortably exceeds bun:test's
    // default 5s hook timeout, so it gets an explicit one here rather
    // than a flaky suite.
  }, 30000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  });

  test("approval, run-failure, mention, and credential-expired each land a row the inbox read path lists", async () => {
    const mailboxDb = createMailboxDb(scratchUrl);
    const deps: NotifyDeliveryDeps = {
      mail: createWorkbenchMailboxDelivery({ db: mailboxDb.db }),
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.test`,
        from: (kind) => `${kind}@notify.test`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    };

    const createdAt = new Date().toISOString();
    const recipients = [{ tenantId, principalId }];

    try {
      const approval = await deliverApprovalMail(deps, {
        kind: "approval",
        approvalId: generateId("approval"),
        tenantId,
        runId: generateId("workflowRun"),
        deploymentId: generateId("workflowRun"),
        toolName: "delete_repo",
        toolArguments: { repo: "corbitsdev/workbench" },
        recipients,
        createdAt,
      });
      const runFailure = await deliverRunFailureMail(deps, {
        kind: "run-failure",
        tenantId,
        runId: generateId("workflowRun"),
        deploymentId: generateId("workflowRun"),
        runLabel: "Nightly sync",
        error: "timed out",
        recipients,
        createdAt,
      });
      const mention = await deliverMentionMail(deps, {
        kind: "mention",
        tenantId,
        threadId: `chn_${crypto.randomUUID()}`,
        threadLabel: "#growth",
        mentionedBy: "prn_someone",
        excerpt: "@you can you take a look?",
        recipients,
        createdAt,
      });
      const credential = await deliverCredentialMail(deps, {
        kind: "credential-expired",
        tenantId,
        credentialId: generateId("credential"),
        providerId: "huggingface",
        providerLabel: "Hugging Face",
        recipients,
        createdAt,
      });

      for (const report of [approval, runFailure, mention, credential]) {
        expect(report.deliveredMailboxRowIds).toHaveLength(1);
      }

      const store = await openNativeMailboxStore(mailboxDb.db, {
        tenantId,
        principalId,
        folder: "INBOX",
      });
      expect(store.messages).toHaveLength(4);
      const subjects = store.messages.map((message) => message.envelope.subject);
      expect(subjects.some((subject) => subject.includes("delete_repo"))).toBe(true);
      expect(subjects.some((subject) => subject.includes("failed"))).toBe(true);
      expect(subjects.some((subject) => subject.includes("mentioned you"))).toBe(true);
      expect(subjects.some((subject) => subject.includes("Reconnect"))).toBe(true);

      expect(store.messages.every((message) => !message.flags.has("\\Seen"))).toBe(true);
    } finally {
      await mailboxDb.close();
    }
  }, 15000);

  test("a crash between mail write and dispatch enqueue is repaired on redelivery without doubles (CL-7238)", async () => {
    const mailboxDb = createMailboxDb(scratchUrl);
    try {
      const innerDispatch = createInMemoryNotifyDispatchStore();
      let crashNext = true;
      const dispatch: NotifyDispatchStore = {
        ...innerDispatch,
        enqueue: async (inputs) => {
          if (crashNext) {
            crashNext = false;
            throw new Error("boom: crash between the mail write and the dispatch enqueue");
          }
          await innerDispatch.enqueue(inputs);
        },
      };
      const delivered: SinkDeliveryResult = { status: "delivered" };
      const sinks = createSinkRegistry();
      sinks.register({
        name: "always",
        isEnabledFor: async () => true,
        deliver: async () => delivered,
      });
      const deps: NotifyDeliveryDeps = {
        mail: createWorkbenchMailboxDelivery({ db: mailboxDb.db }),
        addressing: {
          inbox: (recipient) => `${recipient.principalId}@inbox.test`,
          from: (kind) => `${kind}@notify.test`,
        },
        dispatch,
        resolveExistingMailIds: createResolveExistingMailIds(mailboxDb.db),
        sinks,
      };
      const event: ApprovalNotification = {
        kind: "approval",
        approvalId: generateId("approval"),
        tenantId,
        runId: generateId("workflowRun"),
        deploymentId: generateId("workflowRun"),
        toolName: "quarantine_token",
        toolArguments: { repo: "corbitsdev/workbench" },
        recipients: [{ tenantId, principalId }],
        createdAt: new Date().toISOString(),
      };

      // The first attempt commits its mail row through the real adapter,
      // then dies before the dispatch enqueue — the crash window.
      await expect(deliverApprovalMail(deps, event)).rejects.toThrow("boom");

      // The redelivery dedupes on the mail key (no new row), resolves the
      // committed row's id through the adapter read-back, and queues the
      // dispatch the crash swallowed.
      const redelivery = await deliverApprovalMail(deps, event);
      expect(redelivery.deliveredMailboxRowIds).toEqual([]);
      expect(redelivery.queuedDispatchCount).toBe(1);

      const store = await openNativeMailboxStore(mailboxDb.db, {
        tenantId,
        principalId,
        folder: "INBOX",
      });
      // Exactly one mail row for the redelivered event — the crash and
      // both redeliveries deduped onto the first attempt's row.
      const matching = store.messages.filter((message) =>
        message.envelope.subject.includes("quarantine_token"),
      );
      expect(matching).toHaveLength(1);
      const rows = await mailboxDb.db
        .select({ id: principalMail.id })
        .from(principalMail)
        .where(
          and(
            eq(principalMail.tenantId, tenantId),
            eq(principalMail.principalId, principalId),
            like(principalMail.subject, "%quarantine_token%"),
          ),
        );
      const mailId = rows[0]?.id;
      if (mailId === undefined) throw new Error("expected the redelivered mail row to list");
      expect(await dispatch.listFor(mailId)).toHaveLength(1);

      // A further benign redelivery repairs the same row again, and the
      // dispatch store's (mail row, sink) dedupe holds it to one row.
      const third = await deliverApprovalMail(deps, event);
      expect(third.deliveredMailboxRowIds).toEqual([]);
      expect(third.queuedDispatchCount).toBe(1);
      expect(await dispatch.listFor(mailId)).toHaveLength(1);
    } finally {
      await mailboxDb.close();
    }
  }, 15000);
});
