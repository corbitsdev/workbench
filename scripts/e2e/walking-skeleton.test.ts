// The end-to-end walking skeleton, run against the real stack: a fresh
// platform schema built by scripts/db-setup.ts, the hub and the sidecar
// as spawned processes, and a real Postgres named by DATABASE_URL.
//
// The path proven, hop by hop: database setup → hub boot → sidecar
// dial-in → sign-up → tenant creation → the echo extension route inside
// that tenant → workflow-asset publication over the platform's git
// smart-HTTP surface → the native workflow deploy → the deployment
// answering at its mail address (trigger accepted for delivery).
//
// The gate this suite holds is deployment-addressable: the trigger mail
// is minted and accepted (HTTP 202) at the deployment's address. Full
// run-completion additionally requires a real inference credential,
// which this suite deliberately does not carry — the deploy's inference
// source is a placeholder, so the run the trigger starts is not
// asserted on.
//
// This is permanent smoke coverage, not a demo script: each run resets
// its own sibling `<database>_e2e` database, failures name the hop that
// broke, and teardown stops every spawned process.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "../../workflows/echo/src/index.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  pushWorkflowJson,
  startHub,
  startSidecar,
  type ApiResult,
  type HubHandle,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "walking-skeleton: DATABASE_URL is not set; suite skipped. " +
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

describe.skipIf(databaseUrl === undefined)("walking skeleton", () => {
  test("fresh schema to addressable echo-workflow deployment", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    // Hop: database setup. A fresh schema built by our db-setup, and
    // the setup's own idempotence: a second call reports "unchanged".
    await hop("database setup", async () => {
      await resetSchema(url);
      const first = await setupDatabase(url);
      expect(first.action).toBe("migrated");
      expect(first.migrations).toBeGreaterThan(0);
      const second = await setupDatabase(url);
      expect(second.action).toBe("unchanged");
      expect(second.migrations).toBe(first.migrations);
    });

    // Hop: sidecar provisioning. The identity row the hub checks the
    // sidecar's dial-in token against.
    const sidecarId = "sidecar-e2e";
    const sidecarToken = crypto.randomUUID();
    await hop("sidecar provisioning", () =>
      provisionSidecar(url, sidecarId, sidecarToken),
    );

    // Hop: hub boot. The composition root as a real process.
    const hub: HubHandle = await hop("hub boot", async () => {
      const handle = await startHub({
        databaseUrl: url,
        port: freePort(),
        sessionSecret: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("hex"),
        dataDir: await tempDir("e2e-hub-data-"),
      });
      track(handle);
      return handle;
    });

    // Hop: sidecar boot. Dial-in readiness is observed at the deploy
    // hop (the hub answers 502 until a sidecar is connected).
    const sidecar = await hop("sidecar boot", async () => {
      const app = startSidecar({
        hubPort: new URL(hub.baseUrl).port
          ? Number(new URL(hub.baseUrl).port)
          : 80,
        sidecarId,
        token: sidecarToken,
        dataDir: await tempDir("e2e-sidecar-data-"),
      });
      track(app);
      return app;
    });

    // Hop: sign-up. A browser-shaped account creation through the
    // platform's better-auth surface; the session cookie carries the
    // rest of the skeleton.
    const user = await hop("sign-up", async () => {
      const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Skeleton Tester",
        email: `skeleton-${crypto.randomUUID()}@example.invalid`,
        password: `pw-${crypto.randomUUID()}`,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res;
    });

    // Hop: tenant creation via the native route. The signing user
    // becomes the tenant owner.
    const slug = `e2e${crypto.randomUUID().slice(0, 8)}`;
    const tenantId = await hop("tenant creation", async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        "/api/tenants",
        { name: "Walking Skeleton", slug },
        user.cookies,
      );
      expectStatus("create tenant", res, 201);
      return stringField(res.data, "id", "create tenant");
    });

    // Hop: echo extension route. The one extension the hub mounts,
    // reached inside the platform's native tenant middleware: an
    // anonymous request is refused, a member's body comes back
    // verbatim.
    await hop("echo extension route", async () => {
      const anonymous = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/echo`,
        { probe: true },
      );
      expectStatus("echo without a session", anonymous, 401);

      const body = `hello from the walking skeleton ${crypto.randomUUID()}`;
      const res = await fetch(`${hub.baseUrl}/api/tenants/${tenantId}/echo`, {
        method: "POST",
        headers: { cookie: user.cookies.join("; ") },
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
    });

    // Hop: workflow asset. The echo workflow definition, built by its
    // own package, published as a workflow asset whose workflow.json
    // arrives over the platform's git smart-HTTP surface — the only
    // surface that writes asset tree content.
    const assetName = "echo";
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
          name: "e2e-workflow-push",
          resource: "asset:*",
          refPattern: "**",
          actions: ["can_read", "can_push"],
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        user.cookies,
      );
      expectStatus("mint git token", minted, 201);

      const definition = buildEchoWorkflow({
        triggerAddress: `echo@${slug}.localhost`,
        inferencePreferences: [
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
        turnTimeoutMs: 60_000,
      });
      await pushWorkflowJson({
        baseUrl: hub.baseUrl,
        tenantId,
        assetName,
        tokenSecret: stringField(minted.data, "secret", "mint git token"),
        workflowJson: serializeEchoWorkflow(definition),
      });
      return id;
    });

    // Hop: workflow deploy via the native deploy API. Retries while
    // the hub still answers 502 (the sidecar's dial-in may not have
    // completed yet); any other failure is final. The inference
    // source is a placeholder — deployment does not call inference.
    const deploymentId = await hop("workflow deploy", async () => {
      const sourceId = "src-echo-e2e";
      const body = {
        assetId,
        sources: [
          {
            id: sourceId,
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            apiKey: "e2e-placeholder",
            model: "claude-sonnet-5",
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
      expectStatus("deploy workflow", res, 201);
      return stringField(res.data, "id", "deploy workflow");
    });

    // Hop: deployment addressable. The deployment is listed, and the
    // native trigger route mints the signed trigger mail and accepts
    // it for delivery at the deployment's address — proof the address
    // routes to the live sidecar-hosted deployment.
    await hop("deployment addressable", async () => {
      const listed = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${tenantId}/workflows/deployments`,
        undefined,
        user.cookies,
      );
      expectStatus("list deployments", listed, 200);
      if (!JSON.stringify(listed.data).includes(deploymentId)) {
        throw new Error(
          `deployment ${deploymentId} missing from list: ` +
            JSON.stringify(listed.data),
        );
      }

      const triggered = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/workflows/${deploymentId}/mail`,
        { content: "hello, walking skeleton" },
        user.cookies,
      );
      expectStatus("trigger deployment mail", triggered, 202);
      const address = stringField(
        triggered.data,
        "address",
        "trigger deployment mail",
      );
      // The deployment's stable mail address. This same value is also the
      // deployment's run identity: the platform derives one run id from
      // the address, shared by every trigger of the deployment. The
      // per-trigger correlation handle is the response's messageId, which
      // this suite does not follow up on (run-completion needs a real
      // inference credential).
      expect(address).toBe(`${deploymentId}@${slug}.localhost`);
    });

    console.log(
      "walking-skeleton: gate achieved: deployment-addressable " +
        "(trigger mail accepted for delivery). Run-completion is not " +
        "asserted: it requires a real inference credential, and this " +
        "suite deploys with a placeholder source.",
    );
  }, 180_000);
});
