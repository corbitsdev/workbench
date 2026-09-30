// Proves the client-driven install over stock routes: a package's source goes
// into a fresh tenant as a workflow asset, deploys, and answers mail. A second
// install of identical input deploys nothing new; a changed offering chain or
// `redeploy: true` does. Skips without DATABASE_URL.
// LightningFS, the browser fs the installer uses, needs IndexedDB.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { type } from "arktype";
import { renderBundledWorkflowSourceTree } from "../../packages/workflows/src/client";
import { installPackage } from "../../apps/web/src/install-package";
import { dbGate } from "../lib/db-gate";
import { bootHub } from "../lib/hub";

const describeIfDb = dbGate(process.env["DATABASE_URL"] ?? "", import.meta.path);

const Id = type({ id: "string" });
const Deployments = type({ id: "string" }).array();
const RunList = type({ runIds: "string[]" });

async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    throw: true,
  });
  return (await built.outputs[0]?.text()) ?? "";
}

describeIfDb("installPackage", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  beforeAll(() => {
    // Bound before the hub boots so BASE_URL names the real port.
    server = Bun.serve({ port: 0, fetch: () => new Response("booting", { status: 503 }) });
  });
  // The in-process sidecar dials the hub's own port back.
  const booted = bootHub({
    baseUrl: () => `http://localhost:${String(server?.port)}`,
    port: () => server?.port ?? 0,
  });

  afterAll(async () => {
    await server?.stop(true);
  });

  test("installs echo once, mails it, and reinstalls as a no-op", async () => {
    const hub = booted();
    if (server === undefined) throw new Error("server not bound");
    server.reload({
      websocket: hub.websocket as Bun.WebSocketHandler<unknown>,
      fetch: (req, srv) => hub.fetch(req, srv),
    });
    const origin = `http://localhost:${String(server.port)}`;
    const suffix = crypto.randomUUID().slice(0, 8);

    const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `alice-${suffix}@example.com`,
        password: "password123",
        name: "alice",
      }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const call = (input: string | URL | Request, init: RequestInit = {}) =>
      fetch(input, {
        ...init,
        headers: { origin, cookie, ...(init.headers as Record<string, string> | undefined) },
      });
    const post = (route: string, body: unknown) =>
      call(`${origin}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    async function created(res: Response): Promise<string> {
      expect(res.status).toBe(201);
      return Id.assert(await res.json()).id;
    }

    const tenantId = await created(
      await post("/api/tenants", { name: "Workspace", slug: `ws-${suffix}` }),
    );

    // A model offering is the one thing a deployment needs from the tenant.
    const t = `/api/tenants/${tenantId}`;
    const provider = await created(
      await post(`${t}/providers`, {
        name: "anthropic",
        plugin: "anthropic",
        apiBaseUrl: "https://api.anthropic.com",
      }),
    );
    const credential = await created(
      await post(`${t}/credentials`, {
        providerId: provider,
        name: "anthropic-key",
        type: "api_key",
        secret: "sk-ant-placeholder",
      }),
    );
    const modelProvider = await created(
      await post(`${t}/catalog/providers`, {
        name: "anthropic",
        plugin: "anthropic",
        baseURL: "https://api.anthropic.com",
        credentialId: credential,
      }),
    );
    const model = await created(
      await post(`${t}/catalog/models`, { canonicalName: "claude-sonnet-4-5" }),
    );
    const offering = await created(
      await post(`${t}/catalog/offerings`, {
        modelId: model,
        providerId: modelProvider,
        priority: 0,
      }),
    );

    const workflow = await bundle(path.join(import.meta.dir, "echo-workflow.ts"));
    const files = renderBundledWorkflowSourceTree({
      packageName: "@workbench-e2e/echo",
      bundle: workflow,
      directorsBundle: await bundle(path.join(import.meta.dir, "echo-directors.ts")),
      buildExport: "buildEchoWorkflow",
      buildInput: {
        triggerAddress: `echo@ws-${suffix}.localhost`,
        inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
      },
      workflowJson: "{}",
    });
    const install = (over: { offering?: string; redeploy?: boolean } = {}) =>
      installPackage({
        fetch: call as typeof fetch,
        origin,
        tenantId,
        assetName: "echo",
        displayName: "Echo",
        files,
        entry: "./workflow.js",
        sourceOfferingIds: [over.offering ?? offering],
        defaultSourceOfferingId: over.offering ?? offering,
        ...(over.redeploy === true ? { redeploy: true } : {}),
      });

    const first = await install();
    const listed = Deployments.assert(
      await (await call(`${origin}${t}/workflows/deployments`)).json(),
    );
    expect(listed.map((d) => d.id)).toEqual([first.deploymentId]);

    const mailed = await post(`${t}/workflows/${first.deploymentId}/mail`, { content: "hello" });
    expect(mailed.status).toBe(202);
    // The run commits its first events asynchronously after the mail is accepted.
    let runIds: string[] = [];
    for (let attempt = 0; attempt < 40 && runIds.length === 0; attempt++) {
      runIds = RunList.assert(
        await (await call(`${origin}${t}/workflows/${first.deploymentId}/runs`)).json(),
      ).runIds;
      if (runIds.length === 0) await Bun.sleep(500);
    }
    expect(runIds.length).toBeGreaterThan(0);

    const second = await install();
    expect(second).toEqual(first);
    const after = Deployments.assert(
      await (await call(`${origin}${t}/workflows/deployments`)).json(),
    );
    expect(after).toHaveLength(1);

    const deploymentCount = async () =>
      Deployments.assert(await (await call(`${origin}${t}/workflows/deployments`)).json()).length;

    // The same tree under a different offering chain is a different deploy.
    const modelProvider2 = await created(
      await post(`${t}/catalog/providers`, {
        name: "anthropic-2",
        plugin: "anthropic",
        baseURL: "https://api.anthropic.com",
        credentialId: credential,
      }),
    );
    const offering2 = await created(
      await post(`${t}/catalog/offerings`, {
        modelId: model,
        providerId: modelProvider2,
        priority: 1,
      }),
    );
    const swapped = await install({ offering: offering2 });
    expect(swapped.deploymentId).not.toBe(first.deploymentId);
    expect(await deploymentCount()).toBe(2);

    // An explicit redeploy always deploys anew, even for identical input.
    const again = await install({ offering: offering2, redeploy: true });
    expect(again.deploymentId).not.toBe(swapped.deploymentId);
    expect(await deploymentCount()).toBe(3);
  }, 120_000);
});
