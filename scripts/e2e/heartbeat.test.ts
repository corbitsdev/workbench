// A light end-to-end smoke test for the heartbeat workflow: the real
// hub and sidecar as spawned processes against a real Postgres, a
// heartbeat deployment whose inference source is the hub's own
// `noop-inference` endpoint (not a placeholder, not a real provider),
// and a trigger that starts a run.
//
// This is the proof-by-construction that heartbeat costs nothing to
// run frequently: the deploy's source is a real, reachable endpoint
// (unlike the walking skeleton's `https://inference.invalid`
// placeholder), so a run started against it actually resolves its
// inference call — against `noop-inference`'s constant, locally
// served reply, never a real model.

import { describe, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  HEARTBEAT_STEP_ID,
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../workflows/heartbeat/src/index.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  expectStepCompleted,
  freePort,
  hop,
  provisionSidecar,
  pushWorkflowJson,
  startHub,
  startSidecar,
  waitForRunCompletion,
  type ApiResult,
  type HubHandle,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "heartbeat: DATABASE_URL is not set; suite skipped. " +
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

function runIds(data: unknown): string[] {
  if (
    typeof data === "object" &&
    data !== null &&
    "runIds" in data &&
    Array.isArray((data as Record<string, unknown>)["runIds"])
  ) {
    return (data as { runIds: unknown[] }).runIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  throw new Error(`expected a runIds array: ${JSON.stringify(data)}`);
}

const { tempDir, track } = createCleanupHarness();

describe.skipIf(databaseUrl === undefined)("heartbeat workflow", () => {
  // Previously skipped (CL-6004): the first mail trigger against a freshly
  // deployed workflow deterministically failed to complete, with the hub
  // logging repeated `Workflow-run pack rejected ... source address has no
  // live deployment anchor` / `path_violation` warnings for the run's own
  // workflow-run repo and the deployment left durably stuck. Both halves of
  // that shape are now fixed in the vendored tree (see
  // `docs/revendor-inventory.md`): `receiveWorkflowRunPack` no longer gates
  // pack acceptance on a live run status, so a settling run can still land the
  // bookkeeping that retires its in-flight mail; and the supervisor's turn-2
  // resume path drops mail with no conversation text instead of delivering an
  // empty string that throws inside `agent.send` and fails the step with
  // `retriesExhausted`.
  test("launching heartbeat against the hub's own noop-inference endpoint starts a run", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const sidecarId = "sidecar-e2e-heartbeat";
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
        dataDir: await tempDir("e2e-heartbeat-hub-data-"),
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
        dataDir: await tempDir("e2e-heartbeat-sidecar-data-"),
      });
      track(app);
      return app;
    });

    const user = await hop("sign-up", async () => {
      const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Heartbeat Tester",
        email: `heartbeat-${crypto.randomUUID()}@example.invalid`,
        password: `pw-${crypto.randomUUID()}`,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res;
    });

    const slug = `e2ehb${crypto.randomUUID().slice(0, 8)}`;
    const tenantId = await hop("tenant creation", async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        "/api/tenants",
        { name: "Heartbeat Smoke", slug },
        user.cookies,
      );
      expectStatus("create tenant", res, 201);
      return stringField(res.data, "id", "create tenant");
    });

    const assetName = "heartbeat";
    const assetId = await hop("workflow asset publication", async () => {
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
          name: "e2e-heartbeat-push",
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
      await pushWorkflowJson({
        baseUrl: hub.baseUrl,
        tenantId,
        assetName,
        tokenSecret: stringField(minted.data, "secret", "mint git token"),
        workflowJson: serializeHeartbeatWorkflow(definition),
      });
      return id;
    });

    // The deploy's source is the hub's own, really-reachable
    // noop-inference endpoint — not a placeholder like the walking
    // skeleton's `https://inference.invalid`. That distinction is the
    // whole point of this suite: a run started against this source
    // actually completes an inference call, at zero cost, because
    // noop-inference answers it locally without reaching a real model.
    const deploymentId = await hop("workflow deploy", async () => {
      const sourceId = "src-heartbeat-e2e";
      const body = {
        assetId,
        sources: [
          {
            id: sourceId,
            provider: "anthropic",
            baseURL: `${hub.baseUrl}/api/chat/noop-inference`,
            apiKey: "noop",
            model: "noop",
          },
        ],
        defaultSource: sourceId,
      };
      const deadline = Date.now() + 60_000;
      let res: ApiResult;
      for (;;) {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before deploy; output:\n${sidecar.output()}`,
          );
        }
        res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/workflows/deployments`,
          body,
          user.cookies,
        );
        if (res.status !== 502) break;
        if (Date.now() > deadline) {
          throw new Error(
            `sidecar never became deployable (hub kept answering 502): ` +
              `${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
          );
        }
        await Bun.sleep(1000);
      }
      expectStatus("deploy heartbeat workflow", res, 201);
      return stringField(res.data, "id", "deploy heartbeat workflow");
    });

    const startedRunId = await hop(
      "heartbeat run starts against noop-inference",
      async () => {
        const before = new Set(
          runIds(
            (
              await api(
                hub.baseUrl,
                "GET",
                `/api/tenants/${tenantId}/workflows/${deploymentId}/runs`,
                undefined,
                user.cookies,
              )
            ).data,
          ),
        );

        const triggered = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/workflows/${deploymentId}/mail`,
          { content: "heartbeat" },
          user.cookies,
        );
        expectStatus("trigger heartbeat mail", triggered, 202);

        const deadline = Date.now() + 30_000;
        for (;;) {
          const listed = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/workflows/${deploymentId}/runs`,
            undefined,
            user.cookies,
          );
          const started = runIds(listed.data).find((id) => !before.has(id));
          if (started !== undefined) return started;
          if (Date.now() > deadline) {
            throw new Error(
              "heartbeat trigger was accepted but no run started within 30s",
            );
          }
          await Bun.sleep(500);
        }
      },
    );

    // The real gate: a run id proves only that the mail route accepted
    // the trigger. Whether the deployment actually resolves — the
    // step's agent launching, its turn completing against
    // noop-inference, the run reaching a terminal state — is only
    // proven by the run's own event log. A broken agent launch or a
    // rejected inference call surfaces here as RunFailed (or no
    // terminal event at all), failing this loudly instead of a
    // "started" run standing in for a working platform.
    const events = await hop("heartbeat run completes", () =>
      waitForRunCompletion(
        hub.baseUrl,
        tenantId,
        deploymentId,
        startedRunId,
        user.cookies,
        30_000,
      ),
    );
    expectStepCompleted(events, HEARTBEAT_STEP_ID);

    console.log(
      "heartbeat: gate achieved: a run completed against the real, " +
        "reachable noop-inference source, proving the deployment " +
        "resolves at zero cost.",
    );
  }, 180_000);
});
