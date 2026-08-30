// CL-6038: a routine's stored trigger input must reach the run. Proves
// the fix end to end, against a real Postgres and a real hub+sidecar
// pair, with the hub's own noop-inference endpoint standing in for a
// model provider (zero-cost, same pattern as `routine-repeat.test.ts`
// and `smoke-webhook.test.ts`): "run now" and a scheduled fire both
// deliver the routine's stored `input` as the launched run's actual
// first message (via `apps/hub/src/routine-launcher.ts`'s
// `sendFoldedMailWithRetry` call); a webhook fire delivers its
// trigger's rendered `inputTemplate` the same way (pre-existing
// behavior in `@corbits/webhook-triggers`, reconfirmed here for
// parity). Each assertion checks the mailbox's first message
// specifically, not merely that a matching message exists somewhere in
// it.
//
// No route exposes a run's mailbox by definition-scoped id today (see
// `smoke-webhook.test.ts`'s own note on this), so every mailbox
// assertion here reads `session_mail` straight out of Postgres, joined
// through `agent_session`/`workflow_run` on the run's own instance id —
// a harness-side fact, not a public contract.
import { createHmac } from "node:crypto";
import { describe, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../workflows/heartbeat/src/index.ts";
import {
  api,
  assertNeverRealProvider,
  connectE2eDb,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  pushWorkflowSource,
  workflowDeployBody,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "routine-trigger-input: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; CI sets E2E_REQUIRED=1 " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

type MailboxMessage = { raw: string; direction: string };

/**
 * Reads every `session_mail` row (signed MIME body plus direction)
 * delivered to the folded run whose `workflow_run.id` is `instanceId`,
 * joined through `agent_session` on the run's own principal — the same
 * principal both rows share, per `launchFoldedRun`'s self-anchored
 * shape — oldest first, so index 0 is the run's actual first message.
 */
async function readMailbox(
  url: string,
  instanceId: string,
): Promise<MailboxMessage[]> {
  const sql = await connectE2eDb(url);
  try {
    const rows = await sql.unsafe(
      `SELECT sm.raw AS raw, sm.direction AS direction
         FROM session_mail sm
         JOIN agent_session ags ON ags.id = sm.session_id
         JOIN workflow_run wr ON wr.principal_id = ags.principal_id
        WHERE wr.id = $1
        ORDER BY sm.created_at ASC`,
      [instanceId],
    );
    return rows.map((row) => {
      const typed = row as { raw: unknown; direction: unknown };
      return { raw: String(typed.raw), direction: String(typed.direction) };
    });
  } finally {
    await sql.end();
  }
}

/**
 * `true` when the mailbox's very first message (not merely "some"
 * message) is inbound and carries every one of `substrings` — proving
 * the routine's stored input landed as the run's actual first-turn
 * content, matching this file's own claim, not just present somewhere
 * in the mailbox.
 */
function firstMessageIsInboundAndContains(
  mailbox: MailboxMessage[],
  ...substrings: string[]
): boolean {
  const first = mailbox[0];
  if (first === undefined || first.direction !== "inbound") return false;
  return substrings.every((substring) => first.raw.includes(substring));
}

describe.skipIf(databaseUrl === undefined)(
  "routine stored trigger input reaches the run",
  () => {
    test("run-now, scheduled, and webhook fires each deliver input as first-turn mail", async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await hop("database setup", async () => {
        await resetSchema(url);
        await setupDatabase(url);
      });

      const sidecarId = "sidecar-e2e-routine-trigger-input";
      const sidecarToken = crypto.randomUUID();
      await hop("sidecar provisioning", () =>
        provisionSidecar(url, sidecarId, sidecarToken),
      );

      const hub: HubHandle = await hop("hub boot", async () => {
        const handle = await startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("e2e-routine-trigger-input-hub-data-"),
        });
        track(handle);
        return handle;
      });

      const sidecar = await hop("sidecar boot", async () => {
        const app = startSidecar({
          hubPort: Number(new URL(hub.baseUrl).port),
          sidecarId,
          token: sidecarToken,
          dataDir: await tempDir("e2e-routine-trigger-input-sidecar-data-"),
        });
        track(app);
        return app;
      });

      const cookies = await hop("sign-up", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
          name: "Routine Input Tester",
          email: `routine-input-${crypto.randomUUID()}@example.invalid`,
          password: `pw-${crypto.randomUUID()}`,
        });
        expectStatus("sign-up", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-up returned no session cookie");
        }
        return res.cookies;
      });

      const slug = `e2eti${crypto.randomUUID().slice(0, 8)}`;
      const tenantId = await hop("tenant creation", async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          "/api/tenants",
          { name: "Routine Trigger Input", slug },
          cookies,
        );
        expectStatus("create tenant", res, 201);
        return stringField(res.data, "id", "create tenant");
      });

      const noopBaseUrl = `${hub.baseUrl}/api/chat/noop-inference`;
      assertNeverRealProvider(noopBaseUrl, "noop catalog provider baseURL");
      await hop("noop catalog seeding", async () => {
        const model = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/models`,
          { canonicalName: "noop" },
          cookies,
        );
        expectStatus("create catalog model", model, 201);
        const modelId = stringField(model.data, "id", "create catalog model");

        const provider = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/providers`,
          { name: "anthropic", plugin: "anthropic" },
          cookies,
        );
        expectStatus("create provider", provider, 201);
        const providerId = stringField(provider.data, "id", "create provider");

        const credential = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/credentials`,
          {
            providerId,
            name: "anthropic-default",
            type: "api_key",
            secret: "noop",
          },
          cookies,
        );
        expectStatus("create credential", credential, 201);
        const credentialId = stringField(
          credential.data,
          "id",
          "create credential",
        );

        const catalogProvider = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/providers`,
          {
            name: "anthropic",
            plugin: "anthropic",
            baseURL: noopBaseUrl,
            credentialId,
          },
          cookies,
        );
        expectStatus("create catalog provider", catalogProvider, 201);
        const catalogProviderId = stringField(
          catalogProvider.data,
          "id",
          "create catalog provider",
        );

        const offering = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/offerings`,
          { modelId, providerId: catalogProviderId },
          cookies,
        );
        expectStatus("create catalog offering", offering, 201);
      });

      const assetName = "heartbeat";
      const { assetId, commitSha } = await hop(
        "workflow asset publication",
        async () => {
          const created = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/assets`,
            { kind: "workflow", name: assetName },
            cookies,
          );
          expectStatus("create workflow asset", created, 201);
          const id = stringField(created.data, "id", "create workflow asset");

          const minted = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/git-tokens`,
            {
              name: "e2e-routine-trigger-input-push",
              resource: "asset:*",
              refPattern: "**",
              actions: ["can_read", "can_push"],
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            },
            cookies,
          );
          expectStatus("mint git token", minted, 201);

          const definition = buildHeartbeatWorkflow({
            triggerAddress: `heartbeat@${slug}.localhost`,
            inferencePreferences: [{ provider: "anthropic", model: "noop" }],
            turnTimeoutMs: 30_000,
          });
          const pushed = await pushWorkflowSource({
            baseUrl: hub.baseUrl,
            tenantId,
            assetName,
            tokenSecret: stringField(minted.data, "secret", "mint git token"),
            workflowJson: serializeHeartbeatWorkflow(definition),
          });
          return { assetId: id, commitSha: pushed.commitSha };
        },
      );

      const definitionId = await hop("workflow deploy", async () => {
        const sourceId = "src-routine-trigger-input-e2e";
        assertNeverRealProvider(noopBaseUrl, "workflow deploy source baseURL");
        const body = workflowDeployBody({
          assetId,
          commitSha,
          sourceId: sourceId,
          provider: "anthropic",
          baseURL: noopBaseUrl,
          apiKey: "noop",
          model: "noop",
        });
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before deploy; output:\n${sidecar.output()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/workflows/deployments`,
            body,
            cookies,
          );
          if (res.status === 502) {
            if (Date.now() > deadline) {
              throw new Error(
                `sidecar never became deployable (hub kept answering 502): ${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
              );
            }
            await Bun.sleep(200);
            continue;
          }
          expectStatus("deploy heartbeat workflow", res, 201);
          break;
        }

        const listed = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/workflows/definitions`,
          undefined,
          cookies,
        );
        expectStatus("list workflow definitions", listed, 200);
        const rows =
          typeof listed.data === "object" &&
          listed.data !== null &&
          "data" in listed.data
            ? (listed.data as { data: unknown[] }).data
            : (listed.data as unknown[]);
        const heartbeat = (rows as { id: string; name?: string }[]).find(
          (row) => row.name === assetName,
        );
        if (heartbeat === undefined) {
          throw new Error(
            `no workflow definition named "${assetName}": ${JSON.stringify(listed.data)}`,
          );
        }
        return heartbeat.id;
      });

      const workbenchId = await hop("delivery workbench creation", async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/chat/workbenches`,
          { kind: "workbench", name: "Routine input results" },
          cookies,
        );
        expectStatus("create delivery workbench", res, 201);
        return stringField(res.data, "id", "create delivery workbench");
      });

      // --- Fire 1: "run now" -------------------------------------------
      await hop("run-now fire delivers the stored input", async () => {
        const routine = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/routines`,
          {
            name: "Run-now input routine",
            definitionId,
            trigger: null,
            scope: "bench",
            deliveryWorkbenchId: workbenchId,
            input: { topic: "AI coding agents", focus: "Competing launches" },
          },
          cookies,
        );
        expectStatus("create run-now routine", routine, 201);
        const routineId = stringField(routine.data, "id", "create routine");

        const fired = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/routines/${routineId}/run`,
          {},
          cookies,
        );
        expectStatus("run-now fire", fired, 201);
        const runId = stringField(fired.data, "runId", "run-now fire");

        const deadline = Date.now() + 30_000;
        let mailbox: MailboxMessage[] = [];
        while (Date.now() < deadline) {
          mailbox = await readMailbox(url, runId);
          if (mailbox.length > 0) break;
          await Bun.sleep(200);
        }

        if (
          !firstMessageIsInboundAndContains(
            mailbox,
            "topic: AI coding agents",
            "focus: Competing launches",
          )
        ) {
          throw new Error(
            `run ${runId}'s first mailbox message was not the routine's ` +
              `stored input: ${JSON.stringify(mailbox)}`,
          );
        }
      });

      // --- Fire 2: scheduled ---------------------------------------------
      await hop("scheduled fire delivers the stored input", async () => {
        const routine = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/routines`,
          {
            name: "Scheduled input routine",
            definitionId,
            trigger: { kind: "interval", unit: "minutes", every: 1 },
            scope: "bench",
            deliveryWorkbenchId: workbenchId,
            input: { topic: "Scheduled digest" },
          },
          cookies,
        );
        expectStatus("create scheduled routine", routine, 201);
        const routineId = stringField(routine.data, "id", "create routine");

        // Force the routine due immediately rather than waiting out its
        // own cadence — the only wait left is the scheduler's own poll
        // interval, which the e2e harness sets to 300ms (CL-7250), not
        // the real 30s production cadence.
        const sql = await connectE2eDb(url);
        try {
          await sql.unsafe(
            `UPDATE routines.routine SET next_fire_at = now() - interval '1 second' WHERE id = $1`,
            [routineId],
          );
        } finally {
          await sql.end();
        }

        const deadline = Date.now() + 45_000;
        let runId: string | undefined;
        while (Date.now() < deadline) {
          const runs = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/routines/${routineId}/runs`,
            undefined,
            cookies,
          );
          expectStatus("list routine runs", runs, 200);
          const items = (runs.data as { items: { runId: string }[] }).items;
          if (items.length > 0) {
            runId = items[0]?.runId;
            break;
          }
          await Bun.sleep(200);
        }
        if (runId === undefined) {
          throw new Error(
            `routine ${routineId} never recorded a scheduled fire within ` +
              "the poll deadline",
          );
        }

        const mailboxDeadline = Date.now() + 15_000;
        let mailbox: MailboxMessage[] = [];
        while (Date.now() < mailboxDeadline) {
          mailbox = await readMailbox(url, runId);
          if (mailbox.length > 0) break;
          await Bun.sleep(200);
        }

        if (
          !firstMessageIsInboundAndContains(mailbox, "topic: Scheduled digest")
        ) {
          throw new Error(
            `scheduled run ${runId}'s first mailbox message was not the ` +
              `routine's stored input: ${JSON.stringify(mailbox)}`,
          );
        }
      });

      // --- Fire 3: webhook -------------------------------------------------
      await hop("webhook fire delivers its rendered named fields", async () => {
        const trigger = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/webhook-triggers`,
          {
            name: "Input webhook",
            workflowDefinitionId: definitionId,
            inputTemplate: "topic: {{topic}}\nsource: {{source}}",
          },
          cookies,
        );
        expectStatus("create webhook trigger", trigger, 201);
        const triggerId = stringField(
          trigger.data,
          "id",
          "create webhook trigger",
        );
        const secret = stringField(
          trigger.data,
          "secret",
          "create webhook trigger",
        );

        const routine = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/routines`,
          {
            name: "Webhook input routine",
            definitionId,
            trigger: { kind: "webhook", webhookTriggerId: triggerId },
            scope: "bench",
            deliveryWorkbenchId: workbenchId,
          },
          cookies,
        );
        expectStatus("create webhook-bound routine", routine, 201);

        const rawBody = JSON.stringify({
          topic: "Deploy finished",
          source: "ci",
        });
        const signature = createHmac("sha256", secret)
          .update(rawBody, "utf8")
          .digest("hex");
        const delivered = await fetch(
          `${hub.baseUrl}/api/webhooks/${triggerId}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-webhook-signature": signature,
            },
            body: rawBody,
          },
        );
        const deliveredData = (await delivered.json()) as {
          instanceId: string;
          address: string;
        };
        if (delivered.status !== 202) {
          throw new Error(
            `webhook delivery: expected HTTP 202, got ${delivered.status}: ` +
              JSON.stringify(deliveredData),
          );
        }

        const deadline = Date.now() + 15_000;
        let mailbox: MailboxMessage[] = [];
        while (Date.now() < deadline) {
          mailbox = await readMailbox(url, deliveredData.instanceId);
          if (mailbox.length > 0) break;
          await Bun.sleep(200);
        }

        if (
          !firstMessageIsInboundAndContains(
            mailbox,
            "topic: Deploy finished",
            "source: ci",
          )
        ) {
          throw new Error(
            `webhook run ${deliveredData.instanceId}'s first mailbox ` +
              `message was not the trigger's rendered fields: ` +
              JSON.stringify(mailbox),
          );
        }
      });

      console.log(
        "routine-trigger-input: gate achieved: run-now, scheduled, and " +
          "webhook fires each deliver their input as the run's first-turn mail.",
      );
    }, 180_000);
  },
);
