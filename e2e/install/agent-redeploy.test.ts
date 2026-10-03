// Proves the edit-and-redeploy flow over stock routes: an agent deployed via
// `deployAgentSource` is re-deployed via `redeployAgentForProviderChange`
// after the workspace offering chain changes. The redeploy mints a new
// deployment but keeps the slug (same source asset), the trigger address, the
// system prompt, and the MCP bindings, while adopting the workspace's current
// inference offering. Skips without DATABASE_URL.
//
// TODO(CL-9780): once PR 1093 lands and this branch rebases onto main, extend
// this test to cover the role carry: assign a stock role to the agent's
// workflow principal before the redeploy (POST
// `/api/tenants/:id/principals/:principalId/roles/:roleId`), then assert the
// redeploy re-assigns it to the new deployment's principal. Until then there
// are no roles on this branch to carry, so this test asserts no roles.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type } from "arktype";
import { agentSlugFromSourceAssetName, deployAgentSource } from "../../apps/web/src/agent-deploy";
import {
  needsAgentRedeployForProviderChange,
  readCurrentOfferingSources,
  redeployAgentForProviderChange,
} from "../../apps/web/src/agent-model-redeploy";
import { readAgentMcpHandles, readAgentSource } from "../../apps/web/src/agent-source-read";
import { listChatAgents, type ChatAgent } from "../../apps/web/src/chat/threads-api";
import { fetchSourceFile } from "../../apps/web/src/git-fetch";
import { withGitToken } from "../../apps/web/src/git-token";
import { slugify } from "../../apps/web/src/lib/slug/slug";
import {
  parseWorkflowSourceDefinition,
  WORKFLOW_SOURCE_DEFINITION_PATH,
} from "../../packages/workflows/src/client";
import { dbGate } from "../lib/db-gate";
import { bootHub } from "../lib/hub";

const describeIfDb = dbGate(process.env["DATABASE_URL"] ?? "", import.meta.path);

const Id = type({ id: "string" });
const DefinitionTriggersShape = type({
  triggers: type({ type: "string", to: "string" }).array(),
});
const DeploymentShape = type({ id: "string", status: "string", definitionAssetId: "string" });

// The client deploy/reads below run on ambient `fetch` plus
// `globalThis.location` (a browser surface). In this bun test both are
// shimmed onto the authed hub caller for the duration of the redeploy test,
// then restored — the same dressing `install-package.test.ts` builds per
// call, lifted to ambient so the unmodified product path is exercised.
function installAmbientClientShims(origin: string, cookie: string): () => void {
  const realFetch = globalThis.fetch;
  const hadLocation = "location" in globalThis;
  const previousLocation = (globalThis as { location?: unknown }).location;
  const authed = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${origin}${input}` : input;
    return realFetch(url as string, {
      ...init,
      headers: {
        origin,
        cookie,
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  }) as typeof fetch;
  globalThis.fetch = authed;
  (globalThis as { location?: unknown }).location = { origin };
  return () => {
    globalThis.fetch = realFetch;
    if (hadLocation) {
      (globalThis as { location?: unknown }).location = previousLocation;
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  };
}

describeIfDb("agent redeploy on provider change", () => {
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

  test("redeploy keeps slug, address, prompt, and MCP bindings on a new offering", async () => {
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

    const tenantSlug = `ws-redeploy-${suffix}`;
    const tenantId = await created(
      await post("/api/tenants", { name: "Workspace", slug: tenantSlug }),
    );
    const domain = `${tenantSlug}.localhost`;

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
    await created(
      await post(`${t}/catalog/offerings`, {
        modelId: model,
        providerId: modelProvider,
        priority: 0,
      }),
    );

    // One workspace-catalog MCP server, stored exactly the way the Tools page
    // stores one (provider row plus a credential carrying the `mcp` catalog),
    // so the agent has a binding worth preserving. No discovery runs: the
    // deploy reads the stored catalog, never the network.
    const mcpProvider = await created(
      await post(`${t}/providers`, {
        name: `mcp-notes-${suffix}`,
        plugin: "mcp-streamable-http",
        apiBaseUrl: "https://notes.example.com",
      }),
    );
    await created(
      await post(`${t}/credentials`, {
        providerId: mcpProvider,
        name: `mcp-notes-cred-${suffix}`,
        type: "api_key",
        secret: "no-token",
        metadata: {
          mcp: {
            handle: "notes",
            name: "Notes",
            url: "https://notes.example.com",
            auth: "none",
            tools: [],
          },
        },
      }),
    );

    const restoreAmbient = installAmbientClientShims(origin, cookie);
    try {
      const name = "Note Taker";
      const slug = slugify(name);
      const assetName = `agent-${slug}-source`;
      const systemPrompt = "You are a note-taking assistant. Be concise.";
      const triggerAddress = `${slug}@${domain}`;

      // The mail trigger recipient the deployed definition carries — the
      // address half of "same slug/trigger address" (the run address itself
      // is per-deployment by design: the hub mints it at deploy time).
      async function readTriggerRecipients(assetId: string): Promise<readonly string[]> {
        const gitUrl = `${origin}/api/tenants/${encodeURIComponent(tenantId)}/assets/workflow/${assetName}.git`;
        return withGitToken({
          tenantId,
          assetId,
          actions: ["can_read"],
          lifetimeMs: 10 * 60 * 1000,
          fetchImpl: call as typeof fetch,
          use: async (token) => {
            const file = await fetchSourceFile({
              url: gitUrl,
              token,
              filepath: WORKFLOW_SOURCE_DEFINITION_PATH,
            });
            const parsed = DefinitionTriggersShape(
              JSON.parse(parseWorkflowSourceDefinition(file, assetId)),
            );
            if (parsed instanceof type.errors) {
              throw new Error(`unexpected definition shape: ${parsed.summary}`);
            }
            return parsed.triggers.map((trigger) => trigger.to);
          },
        });
      }

      const first = await deployAgentSource(
        { tenantId, input: { name, systemPrompt, mcpHandles: ["notes"] } },
        call as typeof fetch,
      );
      expect(agentSlugFromSourceAssetName(assetName)).toBe(slug);

      // The roster joins deployments against runs for addresses; right after
      // an install the new deployment row may not be listed yet, so wait for
      // the row itself the way `install-package.test.ts` polls for a run's
      // first events. Status is deliberately unchecked: the run can fail
      // asynchronously (this test's provider key is a placeholder, so the
      // harness cannot reach inference) while the deploy — the asset, the
      // definition, the address it declares — is what this test proves.
      // Waiting on the deployment id (not the roster) also keeps the
      // post-redeploy read from resolving to the previous deployment.
      async function waitForDeployment(deploymentId: string): Promise<void> {
        for (let attempt = 0; attempt < 40; attempt++) {
          const listed = await call(`${origin}${t}/workflows/deployments`);
          const rows = DeploymentShape.array().assert(await listed.json());
          if (rows.some((candidate) => candidate.id === deploymentId)) return;
          await Bun.sleep(500);
        }
        throw new Error(`deployment ${deploymentId} never listed after deploy`);
      }

      async function readLiveAgent(): Promise<ChatAgent> {
        const found = (await listChatAgents(tenantId)).find(
          (candidate) => candidate.assetName === assetName,
        );
        if (found === undefined) throw new Error("agent missing from the roster after deploy");
        return found;
      }

      const readBack = await readAgentSource(
        tenantId,
        first.assetId,
        assetName,
        call as typeof fetch,
      );
      expect(readBack.systemPrompt).toBe(systemPrompt);
      expect(
        await readAgentMcpHandles(tenantId, first.assetId, assetName, call as typeof fetch),
      ).toEqual(["notes"]);

      await waitForDeployment(first.deploymentId);
      const agent = await readLiveAgent();
      // Run addresses are per-deployment (the hub mints them); the roster
      // slot under the same asset name keeps serving this tenant's domain.
      expect(agent.addresses.some((address) => address.endsWith(`@${domain}`))).toBe(true);
      expect(await readTriggerRecipients(first.assetId)).toContain(triggerAddress);

      // The workspace grows a fallback offering: the agent's declared chain
      // no longer matches, so the worker page would offer a re-deploy.
      expect(
        needsAgentRedeployForProviderChange(readBack.declaredSources, readBack.declaredSources),
      ).toBe(false);
      const modelProvider2 = await created(
        await post(`${t}/catalog/providers`, {
          name: "anthropic-2",
          plugin: "anthropic",
          baseURL: "https://api.anthropic.com",
          credentialId: credential,
        }),
      );
      await created(
        await post(`${t}/catalog/offerings`, {
          modelId: model,
          providerId: modelProvider2,
          priority: 1,
        }),
      );

      const redeployed = await redeployAgentForProviderChange(
        { tenantId, agent },
        call as typeof fetch,
      );

      // A new deployment on the same source asset: the slug, and therefore
      // the asset name, trigger address, and cron definition name, survive.
      expect(redeployed.deploymentId).not.toBe(first.deploymentId);
      expect(redeployed.assetId).toBe(first.assetId);

      await waitForDeployment(redeployed.deploymentId);
      const after = await readLiveAgent();
      expect(after.addresses.some((address) => address.endsWith(`@${domain}`))).toBe(true);
      expect(await readTriggerRecipients(redeployed.assetId)).toContain(triggerAddress);

      // Config carries over while inference moves onto the new chain.
      const reread = await readAgentSource(
        tenantId,
        redeployed.assetId,
        assetName,
        call as typeof fetch,
      );
      expect(reread.systemPrompt).toBe(systemPrompt);
      // The redeploy adopts the workspace's current chain: what it declares
      // is exactly what the offering resolves to now.
      const current = await readCurrentOfferingSources(tenantId, call as typeof fetch);
      if (current === null) throw new Error("workspace offering missing after redeploy");
      expect(reread.declaredSources).toEqual([...current]);
      expect(needsAgentRedeployForProviderChange(reread.declaredSources, current)).toBe(false);
      expect(
        await readAgentMcpHandles(tenantId, redeployed.assetId, assetName, call as typeof fetch),
      ).toEqual(["notes"]);
    } finally {
      restoreAmbient();
    }
  }, 180_000);
});
