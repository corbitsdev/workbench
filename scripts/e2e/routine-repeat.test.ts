// The repeat-fire gate for routines: one routine over the zero-cost
// heartbeat definition, fired twice through the same "run now" launcher a
// scheduled trigger uses, both fires accepted and launching their own
// runs. Before Interchange's run-first collapse (INTR-358) the workflow
// deployment cache made the second fire of a definition die with a 409
// `workflow_run_terminal`; a routine could therefore never fire twice.
// Every launch here resolves inference against the hub's own
// noop-inference endpoint, so the whole proof costs nothing.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../workflows/heartbeat/src/index.ts";
import {
  api,
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

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "routine-repeat: DATABASE_URL is not set; suite skipped. " +
      "Set DATABASE_URL (see .env.example) to run it; " +
      "CI sets E2E_REQUIRED=1 so this skip can never pass silently there.",
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

const { tempDir, track } = createCleanupHarness();

describe.skipIf(databaseUrl === undefined)("routine repeat fires", () => {
  test("one routine fired twice launches two distinct runs", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const sidecarId = "sidecar-e2e-routine-repeat";
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
        dataDir: await tempDir("e2e-routine-repeat-hub-data-"),
      });
      track(handle);
      return handle;
    });

    const sidecar = await hop("sidecar boot", async () => {
      const app = startSidecar({
        hubPort: new URL(hub.baseUrl).port
          ? Number(new URL(hub.baseUrl).port)
          : 80,
        sidecarId,
        token: sidecarToken,
        dataDir: await tempDir("e2e-routine-repeat-sidecar-data-"),
      });
      track(app);
      return app;
    });

    const user = await hop("sign-up", async () => {
      const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Routine Tester",
        email: `routine-${crypto.randomUUID()}@example.invalid`,
        password: `pw-${crypto.randomUUID()}`,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res;
    });

    const slug = `e2err${crypto.randomUUID().slice(0, 8)}`;
    const tenantId = await hop("tenant creation", async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        "/api/tenants",
        { name: "Routine Repeat Smoke", slug },
        user.cookies,
      );
      expectStatus("create tenant", res, 201);
      return stringField(res.data, "id", "create tenant");
    });

    // The zero-cost catalog chain the routine fire resolves against:
    // an anthropic-plugin provider whose base URL is the hub's own
    // noop-inference endpoint, a "noop" catalog model, and one offering
    // joining the two. Mirrors what `workbench seed` plants for the
    // catalog-test workflows.
    await hop("noop catalog seeding", async () => {
      const model = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/catalog/models`,
        { canonicalName: "noop" },
        user.cookies,
      );
      expectStatus("create catalog model", model, 201);
      const modelId = stringField(model.data, "id", "create catalog model");

      const provider = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/providers`,
        { name: "anthropic", plugin: "anthropic" },
        user.cookies,
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
        user.cookies,
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
          baseURL: `${hub.baseUrl}/api/chat/noop-inference`,
          credentialId,
        },
        user.cookies,
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
        user.cookies,
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
          user.cookies,
        );
        expectStatus("create workflow asset", created, 201);
        const id = stringField(created.data, "id", "create workflow asset");

        const minted = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/git-tokens`,
          {
            name: "e2e-routine-repeat-push",
            resource: "asset:*",
            refPattern: "**",
            actions: ["can_read", "can_push"],
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
          user.cookies,
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

    // Materializes the workflow definition row a routine binds to. The
    // sidecar must be dial-in complete first, so poll through the 502s.
    const definitionId = await hop("workflow deploy", async () => {
      const sourceId = "src-routine-repeat-e2e";
      const body = workflowDeployBody({
        assetId,
        commitSha,
        sourceId: sourceId,
        provider: "anthropic",
        baseURL: `${hub.baseUrl}/api/chat/noop-inference`,
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
          user.cookies,
        );
        if (res.status === 502) {
          if (Date.now() > deadline) {
            throw new Error(
              `sidecar never became deployable (hub kept answering 502): ` +
                `${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
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
        user.cookies,
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
        { kind: "workbench", name: "Routine results" },
        user.cookies,
      );
      expectStatus("create delivery workbench", res, 201);
      return stringField(res.data, "id", "create delivery workbench");
    });

    const routineId = await hop("routine creation", async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/routines`,
        {
          name: "Heartbeat check",
          definitionId,
          trigger: { kind: "interval", unit: "hours", every: 1 },
          scope: "bench",
          deliveryWorkbenchId: workbenchId,
        },
        user.cookies,
      );
      expectStatus("create routine", res, 201);
      return stringField(res.data, "id", "create routine");
    });

    // The proof: the same routine fires twice through the launcher a
    // scheduled trigger uses. Each fire must be accepted (201, never a
    // 409 workflow_run_terminal) and must launch its own run.
    const runIds: string[] = [];
    for (const fire of [1, 2] as const) {
      const runId = await hop(`fire ${fire}: run now`, async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/routines/${routineId}/run`,
          {},
          user.cookies,
        );
        expectStatus(`routine run now (fire ${fire})`, res, 201);
        return stringField(res.data, "runId", `routine run now (fire ${fire})`);
      });
      runIds.push(runId);
    }
    expect(new Set(runIds).size).toBe(2);

    await hop("both fires recorded against the routine", async () => {
      const res = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${tenantId}/routines/${routineId}/runs`,
        undefined,
        user.cookies,
      );
      expectStatus("list routine runs", res, 200);
      const items = (res.data as { items: { runId: string }[] }).items;
      const recorded = new Set(items.map((item) => item.runId));
      for (const runId of runIds) {
        if (!recorded.has(runId)) {
          throw new Error(
            `fire's run ${runId} missing from the routine's run history: ${JSON.stringify(items)}`,
          );
        }
      }
    });

    console.log(
      "routine-repeat: gate achieved: one routine fired twice and " +
        "launched two distinct runs — the one-shot 409 " +
        "workflow_run_terminal wall is gone.",
    );
  }, 240_000);
});
