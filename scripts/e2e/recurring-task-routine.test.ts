// CL-6053's "recurring task" bridge: a scheduled routine on the
// automatable recurring-task placeholder workflow must dispatch through
// @corbits/tasks' launchTask (apps/hub/src/routine-launcher.ts) rather
// than launching its own (otherwise-unused) folded run, and the result
// must land in the routine creator's Inbox exactly like a manual task —
// never a workbench. Proves, against a real Postgres and a real
// hub+sidecar pair, with the hub's own noop-inference endpoint standing
// in for a model provider (zero-cost, same pattern as
// `routine-repeat.test.ts` and `routine-trigger-input.test.ts`):
//
//   1. The routine can be created with NO deliveryWorkbenchId at all —
//      the honest end-to-end delivery-destination fix (fix #1):
//      recurring-task's `deliveryMode: "inbox"` means
//      `@corbits/routines`' create validation never requires one.
//   2. A scheduled fire (forced due immediately, same trick
//      `routine-trigger-input.test.ts` uses) produces a real task row
//      — not a folded run on the recurring-task definition itself —
//      whose `runId` is exactly what `GET /routines/:id/runs` records
//      for this routine (the same run, one launch, no duplicated
//      bookkeeping).
//   3. That task reaches `status: "done"` and its `resultMailId`
//      resolves to a real Inbox item for the routine's creator,
//      subject naming the dispatched agent — the creator-inbox leg.
import { describe, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "../../workflows/echo/src/index.ts";
import {
  buildRecurringTaskWorkflow,
  serializeRecurringTaskWorkflow,
} from "../../workflows/recurring-task/src/index.ts";
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
  pushWorkflowJson,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "recurring-task-routine: DATABASE_URL is not set; suite skipped. Set " +
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

async function deployWorkflow(args: {
  hubBaseUrl: string;
  tenantId: string;
  slug: string;
  cookies: string[];
  assetName: string;
  workflowJson: string;
  noopBaseUrl: string;
  sidecar: { exited(): boolean; output(): string };
}): Promise<string> {
  const created = await api(
    args.hubBaseUrl,
    "POST",
    `/api/tenants/${args.tenantId}/assets`,
    { kind: "workflow", name: args.assetName },
    args.cookies,
  );
  expectStatus(`create ${args.assetName} asset`, created, 201);
  const assetId = stringField(
    created.data,
    "id",
    `create ${args.assetName} asset`,
  );

  const minted = await api(
    args.hubBaseUrl,
    "POST",
    `/api/tenants/${args.tenantId}/git-tokens`,
    {
      name: `e2e-recurring-task-push-${args.assetName}`,
      resource: "asset:*",
      refPattern: "**",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    args.cookies,
  );
  expectStatus(`mint git token for ${args.assetName}`, minted, 201);

  await pushWorkflowJson({
    baseUrl: args.hubBaseUrl,
    tenantId: args.tenantId,
    assetName: args.assetName,
    tokenSecret: stringField(minted.data, "secret", "mint git token"),
    workflowJson: args.workflowJson,
  });

  const sourceId = `src-recurring-task-e2e-${args.assetName}`;
  assertNeverRealProvider(args.noopBaseUrl, "workflow deploy source baseURL");
  const body = {
    assetId,
    sources: [
      {
        id: sourceId,
        provider: "anthropic",
        baseURL: args.noopBaseUrl,
        apiKey: "noop",
        model: "noop",
      },
    ],
    defaultSource: sourceId,
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (args.sidecar.exited()) {
      throw new Error(
        `sidecar exited before deploying ${args.assetName}; output:\n${args.sidecar.output()}`,
      );
    }
    const res = await api(
      args.hubBaseUrl,
      "POST",
      `/api/tenants/${args.tenantId}/workflows/deployments`,
      body,
      args.cookies,
    );
    if (res.status === 502) {
      if (Date.now() > deadline) {
        throw new Error(
          `sidecar never became deployable for ${args.assetName} (hub kept answering 502): ${JSON.stringify(res.data)}\nsidecar output:\n${args.sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
      continue;
    }
    expectStatus(`deploy ${args.assetName} workflow`, res, 201);
    break;
  }

  const listed = await api(
    args.hubBaseUrl,
    "GET",
    `/api/tenants/${args.tenantId}/workflows/definitions`,
    undefined,
    args.cookies,
  );
  expectStatus("list workflow definitions", listed, 200);
  const rows =
    typeof listed.data === "object" &&
    listed.data !== null &&
    "data" in listed.data
      ? (listed.data as { data: unknown[] }).data
      : (listed.data as unknown[]);
  const found = (rows as { id: string; name?: string }[]).find(
    (row) => row.name === args.assetName,
  );
  if (found === undefined) {
    throw new Error(
      `no workflow definition named "${args.assetName}": ${JSON.stringify(listed.data)}`,
    );
  }
  return found.id;
}

describe.skipIf(databaseUrl === undefined)(
  "a scheduled recurring-task routine dispatches through launchTask and delivers to the creator's Inbox",
  () => {
    test("fires the routine, produces a real task, and delivers its result to the Inbox — never a workbench", async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await hop("database setup", async () => {
        await resetSchema(url);
        await setupDatabase(url);
      });

      const sidecarId = "sidecar-e2e-recurring-task-routine";
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
          dataDir: await tempDir("e2e-recurring-task-routine-hub-data-"),
        });
        track(handle);
        return handle;
      });

      const sidecar = await hop("sidecar boot", async () => {
        const app = startSidecar({
          hubPort: Number(new URL(hub.baseUrl).port),
          sidecarId,
          token: sidecarToken,
          dataDir: await tempDir("e2e-recurring-task-routine-sidecar-data-"),
        });
        track(app);
        return app;
      });

      const cookies = await hop("sign-up", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
          name: "Recurring Task Tester",
          email: `recurring-task-${crypto.randomUUID()}@example.invalid`,
          password: `pw-${crypto.randomUUID()}`,
        });
        expectStatus("sign-up", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-up returned no session cookie");
        }
        return res.cookies;
      });

      const slug = `e2ert${crypto.randomUUID().slice(0, 8)}`;
      const tenantId = await hop("tenant creation", async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          "/api/tenants",
          { name: "Recurring Task", slug },
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

      // The taskable agent the recurring-task routine dispatches to —
      // "echo" is conversational (never automatable), exactly the
      // shape a real task's agent has to be.
      const echoDefinitionId = await hop("deploy the echo agent", () =>
        deployWorkflow({
          hubBaseUrl: hub.baseUrl,
          tenantId,
          slug,
          cookies,
          assetName: "echo",
          workflowJson: serializeEchoWorkflow(
            buildEchoWorkflow({
              triggerAddress: `echo@${slug}.localhost`,
              inferencePreferences: [{ provider: "anthropic", model: "noop" }],
              turnTimeoutMs: 30_000,
            }),
          ),
          noopBaseUrl,
          sidecar,
        }),
      );

      // The bridge itself — its own step is never actually launched
      // (see apps/hub/src/routine-launcher.ts); it only needs to exist
      // as a real, deployed, automatable definition so the routine can
      // be created against it at all.
      const recurringTaskDefinitionId = await hop(
        "deploy the recurring-task bridge workflow",
        () =>
          deployWorkflow({
            hubBaseUrl: hub.baseUrl,
            tenantId,
            slug,
            cookies,
            assetName: "recurring-task",
            workflowJson: serializeRecurringTaskWorkflow(
              buildRecurringTaskWorkflow({
                triggerAddress: `recurring-task@${slug}.localhost`,
                inferencePreferences: [
                  { provider: "anthropic", model: "noop" },
                ],
                turnTimeoutMs: 30_000,
              }),
            ),
            noopBaseUrl,
            sidecar,
          }),
      );

      const routineId = await hop(
        "create the recurring-task routine with no deliveryWorkbenchId",
        async () => {
          // No deliveryWorkbenchId at all — fix #1's whole point: this
          // workflow's deliveryMode is "inbox", so
          // @corbits/routines' create validation must never require
          // one here.
          const routine = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/routines`,
            {
              name: "E2E recurring task",
              definitionId: recurringTaskDefinitionId,
              trigger: { kind: "interval", unit: "minutes", every: 1 },
              scope: "bench",
              input: {
                agent: echoDefinitionId,
                prompt: "Testing 1 2 3",
              },
            },
            cookies,
          );
          expectStatus("create recurring-task routine", routine, 201);
          if (
            (routine.data as Record<string, unknown>)["deliveryWorkbenchId"] !==
            null
          ) {
            throw new Error(
              `expected a null deliveryWorkbenchId on an inbox-delivering routine, got: ${JSON.stringify(routine.data)}`,
            );
          }
          return stringField(routine.data, "id", "create routine");
        },
      );

      const runId = await hop(
        "force the routine due and wait for the scheduled fire",
        async () => {
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
          for (;;) {
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
              const id = items[0]?.runId;
              if (id !== undefined) return id;
            }
            if (Date.now() > deadline) {
              throw new Error(
                `routine ${routineId} never recorded a scheduled fire within the poll deadline`,
              );
            }
            await Bun.sleep(1000);
          }
        },
      );

      await hop(
        "the fire dispatched a real task, which completes and reaches the creator's Inbox",
        async () => {
          const deadline = Date.now() + 60_000;
          let task: Record<string, unknown> | undefined;
          for (;;) {
            const tasks = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenantId}/tasks`,
              undefined,
              cookies,
            );
            expectStatus("list tasks", tasks, 200);
            const items = (tasks.data as { items: Record<string, unknown>[] })
              .items;
            task = items.find((item) => item["runId"] === runId);
            // The orchestrator flips `status` before it records
            // `resultMailId` — wait for BOTH, exactly like local-rip's
            // task leg, or this read races the mail-id write.
            if (
              task !== undefined &&
              task["status"] === "done" &&
              typeof task["resultMailId"] === "string" &&
              task["resultMailId"] !== ""
            ) {
              break;
            }
            if (Date.now() > deadline) {
              throw new Error(
                `no task with runId ${runId} reached status "done" with a recorded resultMailId within the poll deadline; ` +
                  `last seen: ${JSON.stringify(task ?? items)}`,
              );
            }
            await Bun.sleep(1000);
          }

          if (task["definitionId"] !== echoDefinitionId) {
            throw new Error(
              `expected the dispatched task's agent to be echo (${echoDefinitionId}), got: ${JSON.stringify(task)}`,
            );
          }
          const resultMailId = task["resultMailId"];
          if (typeof resultMailId !== "string" || resultMailId === "") {
            throw new Error(
              `expected a resultMailId on the completed task: ${JSON.stringify(task)}`,
            );
          }

          const mailItem = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/inbox/${resultMailId}`,
            undefined,
            cookies,
          );
          expectStatus("fetch the task-result Inbox item", mailItem, 200);
          const subject = (mailItem.data as Record<string, unknown>)["subject"];
          if (
            typeof subject !== "string" ||
            !subject.includes("finished your task")
          ) {
            throw new Error(
              `expected the Inbox item's subject to name a finished task, got: ${JSON.stringify(mailItem.data)}`,
            );
          }
        },
      );

      console.log(
        "recurring-task-routine: gate achieved: a scheduled recurring-task " +
          "fire dispatches through launchTask (never its own folded run) " +
          "with no deliveryWorkbenchId required, and its result reaches the " +
          "creator's Inbox.",
      );
    }, 180_000);
  },
);
