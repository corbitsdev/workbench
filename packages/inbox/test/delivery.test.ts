// DB-gated integration test proving CL-6002's actual outcome: once the
// platform's plus every installed package's migrations are applied through
// scripts/db-setup.ts (the hub's standard migration path), each of the four
// kinds `@corbits/notify` defines writes a real row through
// `createWorkbenchMailboxDelivery`, and that row renders back out through
// `@corbits/mailbox`'s own read path (`listUserMailbox`) — the same query
// the inbox/bell UI drives, grouped the same way `inboxGroupOf` groups it.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { createMailboxDb, listUserMailbox } from "@corbits/mailbox";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  deliverApprovalMail,
  deliverCredentialMail,
  deliverMentionMail,
  deliverRunFailureMail,
  type NotifyDeliveryDeps,
} from "@corbits/notify";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createWorkbenchMailboxDelivery } from "../src/delivery";
import { inboxGroupOf } from "../src/group";
import { WORKBENCH_INBOX_PRIORITIES } from "../src/vocabulary";

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
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb(
  "notify delivery writes a real mailbox row for every notification kind",
  () => {
    const scratchUrl = scratchUrlFor(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
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

        const page = await listUserMailbox(mailboxDb.db, {
          tenantId,
          principalId,
          limit: 10,
          view: "all",
          priorities: WORKBENCH_INBOX_PRIORITIES,
        });
        expect(page.items).toHaveLength(4);

        const groupBySubject = (needle: string): string | undefined => {
          const item = page.items.find((i) =>
            (i.subject ?? "").includes(needle),
          );
          expect(item).toBeDefined();
          return item === undefined ? undefined : inboxGroupOf(item);
        };
        expect(groupBySubject("delete_repo")).toBe("action");
        expect(groupBySubject("failed")).toBe("delivery");
        expect(groupBySubject("mentioned you")).toBe("mention");
        expect(groupBySubject("Reconnect")).toBe("action");

        expect(page.items.every((item) => item.read === false)).toBe(true);
      } finally {
        await mailboxDb.close();
      }
    }, 15000);
  },
);
