// CL-7238 prod closure through the hub's own composed notify deps: the
// credential-expiry sweep mails through `createHubNotifyDeliveryDeps`, so a
// crash between the mail write and the dispatch enqueue must be repaired on
// redelivery — the same crash-window pattern PR #734 proves for the bare
// adapters, here through the exact factory `apps/hub/src/index.ts` composes.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  listUserMailbox,
} from "@corbits/mailbox";
import {
  deliverApprovalMail,
  type ApprovalNotification,
  type NotifyDispatchStore,
  type SinkDeliveryResult,
} from "@corbits/notify";
import { WORKBENCH_INBOX_PRIORITIES } from "@corbits/inbox";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { createHubNotifyDeliveryDeps } from "../src/notify-delivery";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_hub_notify_delivery_test`;
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

describeIfDb(
  "hub notify delivery repairs the CL-7238 crash window on redelivery",
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
      // `@corbits/mailbox`.
      await setupDatabase(scratchUrl);

      const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
      try {
        await db.insert(schema.tenant).values({
          id: tenantId,
          name: "Hub Notify Test Bench",
          slug: `hub-notify-${tenantId}`,
          domain: `hub-notify-${tenantId}.localhost`,
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
      // installed package's; under `bun run test`'s cross-package
      // concurrency that comfortably exceeds bun:test's default 5s hook
      // timeout, so it gets an explicit one here rather than a flaky suite.
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

    test("a crash-window redelivery through the composed hub deps queues its dispatch", async () => {
      const mailboxDb = createMailboxDb(scratchUrl);
      try {
        // Exactly what the hub composes: the factory's own dispatch store
        // and sink registry are the prod path (no sink registered means no
        // fan-out, only the mailbox row the sweep's reader sees). The test
        // registers one sink so the repaired dispatch has somewhere to go,
        // and faults only the dispatch enqueue to open the crash window.
        const deps = createHubNotifyDeliveryDeps({
          mailboxDb: mailboxDb.db,
          bus: createInMemoryMailboxEventBus(),
          host: "hub.test",
        });
        const delivered: SinkDeliveryResult = { status: "delivered" };
        deps.sinks.register({
          name: "always",
          isEnabledFor: async () => true,
          deliver: async () => delivered,
        });
        const dispatch = deps.dispatch;
        let crashNext = true;
        const crashingDispatch: NotifyDispatchStore = {
          ...dispatch,
          enqueue: async (inputs) => {
            if (crashNext) {
              crashNext = false;
              throw new Error(
                "boom: crash between the mail write and the dispatch enqueue",
              );
            }
            await dispatch.enqueue(inputs);
          },
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
        await expect(
          deliverApprovalMail({ ...deps, dispatch: crashingDispatch }, event),
        ).rejects.toThrow("boom");

        // The redelivery runs through the pristine composed deps: it
        // dedupes on the mail key (no new row), resolves the committed
        // row's id through the hub's read-back wiring, and queues the
        // dispatch the crash swallowed. Without `resolveExistingMailIds`
        // in the composed deps this queues nothing.
        const redelivery = await deliverApprovalMail(deps, event);
        expect(redelivery.deliveredMailboxRowIds).toEqual([]);
        expect(redelivery.queuedDispatchCount).toBe(1);

        const page = await listUserMailbox(mailboxDb.db, {
          tenantId,
          principalId,
          limit: 10,
          view: "all",
          priorities: WORKBENCH_INBOX_PRIORITIES,
        });
        // Exactly one mail row for the redelivered event — the crash and
        // the redelivery deduped onto the first attempt's row.
        const matching = page.items.filter((item) =>
          (item.subject ?? "").includes("quarantine_token"),
        );
        expect(matching).toHaveLength(1);
        const mailId = matching[0]?.id;
        if (mailId === undefined)
          throw new Error("expected the redelivered mail row to list");
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
  },
);
