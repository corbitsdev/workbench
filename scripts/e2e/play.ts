// Live play harness: boots the real stack (scratch database, hub,
// sidecar), signs up, connects a provider, mints Myra's workbench, then
// plays a scripted list of human turns and prints every agent reply —
// the fastest way to sit in a real workbench and push Myra with a real
// model. Not a test; nothing here asserts. Usage:
//
//   E2E_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 \
//   DATABASE_URL=postgres://localhost:5432/workbench_play \
//   bun run scripts/e2e/play.ts '["Do research on AI daily for me", "..."]'
//
// PLAY_DUMP=1 also prints filtered sidecar output at the end.
import { expect } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createGitWorkflowPusher,
  createHubAPI,
  DEFAULT_WORKFLOWS,
  seedTenant,
  type ApiCall,
} from "../../packages/hub-client/src/index.ts";
import {
  findPersonalTenant,
  testAndPersistCredential,
  ensureSeeded,
  modelSourceFor,
} from "../../packages/onboarding/src/complete-credential.ts";
import { OLLAMA_PLACEHOLDER_SECRET } from "../../packages/hub-client/src/credential-test.ts";
import {
  api,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  startHub,
  startSidecar,
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "./harness.ts";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
const tracked: SpawnedApp[] = [];
const tempDir = (prefix: string) => mkdtemp(pathJoin(tmpdir(), prefix));
const track = (app: SpawnedApp) => {
  tracked.push(app);
};
process.on("exit", () => {
  for (const a of tracked) {
    try {
      void a.stop();
    } catch {}
  }
});

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "greeting-delivery: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; CI sets E2E_REQUIRED=1 " +
      "so this skip can never pass silently there.",
  );
}

// Never sent anywhere for real: onboarding never probes it (CL-6123),
// and the deployments it seeds carry it as a stored, never-triggered
// source until the assistant's own opening turn genuinely dials it.
const STUB_API_KEY = "e2e-greeting-delivery-stub-key-not-real";

// E2E_PROVIDER=ollama + OLLAMA_BASE_URL turns this suite into a live
// acceptance gate the same way `walkthrough.ts`'s E2E_PROVIDER_API_KEY
// does for Anthropic: a real Ollama instance actually answers the
// greeting kickoff, so the final assertion below expects real prose
// instead of the stub key's credential-error report.
const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"];
const USE_OLLAMA =
  process.env["E2E_PROVIDER"] === "ollama" && OLLAMA_BASE_URL !== undefined;
const CONNECT_PROVIDER = USE_OLLAMA
  ? ("ollama" as const)
  : ("anthropic" as const);
const CONNECT_API_KEY = USE_OLLAMA ? OLLAMA_PLACEHOLDER_SECRET : STUB_API_KEY;

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

function arrayField(data: unknown, field: string, what: string): unknown[] {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  throw new Error(
    `${what}: missing array field "${field}": ${JSON.stringify(data)}`,
  );
}

async function signUp(
  baseUrl: string,
  name: string,
): Promise<{ userId: string; email: string; cookies: string[] }> {
  const email = `greeting-delivery-${crypto.randomUUID()}@example.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
    name,
    email,
    password,
  });
  expectStatus(`sign-up for ${name}`, res, 200);
  if (res.cookies.length === 0) {
    throw new Error(`sign-up for ${name} returned no session cookie`);
  }
  const userId = stringField(
    (res.data as { user: unknown }).user,
    "id",
    `sign-up user field for ${name}`,
  );
  return { userId, email, cookies: res.cookies };
}

const SCRIPT: string[] = JSON.parse(process.argv[2] ?? "[]");
const TURN_TIMEOUT_MS = 420_000;

async function main(): Promise<void> {
  const url = databaseUrl;
  if (url === undefined) throw new Error("unreachable: suite is skipped");

  await hop("database setup", async () => {
    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
  });

  const sidecarId = "greeting-delivery-sidecar";
  const sidecarToken = crypto.randomUUID();
  await provisionSidecar(url, sidecarId, sidecarToken);

  const hub: HubHandle = await hop("hub boot", async () =>
    startHub({
      databaseUrl: url,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: await tempDir("e2e-greeting-delivery-hub-data-"),
    }),
  );
  track(hub);

  const sidecar: SpawnedApp = startSidecar({
    hubPort: new URL(hub.baseUrl).port ? Number(new URL(hub.baseUrl).port) : 80,
    sidecarId,
    token: sidecarToken,
    dataDir: await tempDir("e2e-greeting-delivery-sidecar-data-"),
  });
  track(sidecar);

  const hubApi: ApiCall = createHubAPI(hub.baseUrl);

  const user = await hop("sign-up", () =>
    signUp(hub.baseUrl, "Greeting Delivery Tester"),
  );

  const provisioned = await hop(
    "first-login provisioning mints a personal bench, unseeded",
    async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        "/api/onboarding/provision",
        { name: "Greeting Delivery Tester's Bench" },
        user.cookies,
      );
      expectStatus("provision", res, 200);
      const data = res.data as { kind: string; tenantSlug: string };
      expect(data.kind).toBe("provisioned");
      return data;
    },
  );

  const tenant = await hop(
    "the freshly provisioned bench resolves through findPersonalTenant",
    async () => {
      const found = await findPersonalTenant(
        hubApi,
        user.cookies,
        provisioned.tenantSlug,
      );
      if (found === undefined) {
        throw new Error(
          `findPersonalTenant found nothing for slug ${provisioned.tenantSlug}`,
        );
      }
      return found;
    },
  );

  const pushWorkflow = createGitWorkflowPusher();

  const connected = await hop(
    "connecting a real inference credential via the key path (no provider probe — CL-6123)",
    async () => {
      const testArgs = {
        api: hubApi,
        cookies: user.cookies,
        hubUrl: hub.baseUrl,
        userId: user.userId,
        userEmail: user.email,
        provider: CONNECT_PROVIDER,
        apiKey: CONNECT_API_KEY,
        pushWorkflow,
        log: () => undefined,
      };
      const result = await testAndPersistCredential(
        USE_OLLAMA && OLLAMA_BASE_URL !== undefined
          ? { ...testArgs, baseURLOverride: OLLAMA_BASE_URL }
          : testArgs,
      );
      if (result.kind !== "connected") {
        throw new Error(
          `expected the key-path connect to succeed, got: ${JSON.stringify(result)}`,
        );
      }
      return result;
    },
  );

  await hop(
    "the real, unmodified connect flow fully seeds every default workflow, including 'assistant'",
    async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before ensureSeeded could run; output:\n${sidecar.output()}`,
          );
        }
        try {
          const seedArgs = {
            api: hubApi,
            cookies: user.cookies,
            hubUrl: hub.baseUrl,
            pushWorkflow,
            log: () => undefined,
            tenant: connected,
            provider: CONNECT_PROVIDER,
            apiKey: CONNECT_API_KEY,
          };
          await ensureSeeded(
            USE_OLLAMA && OLLAMA_BASE_URL !== undefined
              ? { ...seedArgs, baseURLOverride: OLLAMA_BASE_URL }
              : seedArgs,
          );
          break;
        } catch (cause) {
          if (Date.now() > deadline) throw cause;
          await Bun.sleep(1000);
        }
      }
    },
  );

  async function deploySeededWorkflows(): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before default workflows could deploy; output:\n${sidecar.output()}`,
        );
      }
      try {
        await seedTenant({
          api: hubApi,
          cookies: user.cookies,
          hubUrl: hub.baseUrl,
          tenant: {
            tenantId: tenant.tenantId,
            principalId: tenant.principalId,
            domain: tenant.tenantDomain,
          },
          model:
            USE_OLLAMA && OLLAMA_BASE_URL !== undefined
              ? modelSourceFor(
                  CONNECT_PROVIDER,
                  CONNECT_API_KEY,
                  OLLAMA_BASE_URL,
                )
              : modelSourceFor(CONNECT_PROVIDER, CONNECT_API_KEY),
          pushWorkflow,
          log: () => undefined,
          workflows: DEFAULT_WORKFLOWS,
          confirmDeployments: false,
        });
        return;
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await Bun.sleep(1000);
      }
    }
  }

  await hop(
    "every default workflow deploys and goes live",
    deploySeededWorkflows,
  );

  const assistantDefinitionId = await hop(
    "the 'assistant' default workflow is invitable tenant-wide",
    async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenant.tenantId}/chat/invitable-definitions`,
          undefined,
          user.cookies,
        );
        if (res.status === 200) {
          const items = arrayField(
            res.data,
            "items",
            "list invitable definitions",
          ) as { id: string; name: string }[];
          const assistant = items.find((item) => item.name === "assistant");
          if (assistant !== undefined) return assistant.id;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `"assistant" never appeared as invitable: ${JSON.stringify(res.data)}`,
          );
        }
        await Bun.sleep(1000);
      }
    },
  );

  const { chatId, agentAddress } = await hop(
    "POST /channels kind=chat definitionId=assistant mints a chat with its one agent already joined",
    async () => {
      const deadline = Date.now() + 60_000;
      let res: ApiResult;
      for (;;) {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before chat creation; output:\n${sidecar.output()}`,
          );
        }
        res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenant.tenantId}/chat/channels`,
          { kind: "chat", definitionId: assistantDefinitionId },
          user.cookies,
        );
        if (res.status !== 500) break;
        if (Date.now() > deadline) {
          throw new Error(
            `chat never became mintable (hub kept answering 500): ` +
              `${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
          );
        }
        await Bun.sleep(1000);
      }
      expectStatus("create chat", res, 201);
      const id = stringField(res.data, "id", "create chat");
      const participants = arrayField(
        res.data,
        "participants",
        "create chat",
      ) as { address: string; handle: string }[];
      const agent = participants.find((p) => p.handle === "myra");
      if (agent === undefined) {
        throw new Error(
          `chat has no "myra" agent participant: ${JSON.stringify(participants)}`,
        );
      }
      return { chatId: id, agentAddress: agent.address };
    },
  );

  // The proof: poll the freshly minted chat's own timeline for an
  // agent-authored message, sending no user message at any point.
  // A stub key dialing the real Anthropic host answers with a real
  // 401, which the platform's own inference director folds into a
  // *completed* turn carrying a self-describing credential-error
  // report rather than failing the run outright (see
  // `vendor/intx/inference/src/default-director.ts` and
  // `local-rip.test.ts`'s task leg, which asserts the identical
  // text for the same reason) — that report landing here, with
  // zero human messages sent, is the honest, deterministic proof
  // that the greeting kickoff's mail actually triggered the
  // agent's turn.
  await hop(
    "an agent-authored message lands in the chat with no user message ever sent",
    async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenant.tenantId}/chat/channels/${chatId}/messages`,
          undefined,
          user.cookies,
        );
        expectStatus("list chat messages", res, 200);
        const items = arrayField(res.data, "items", "list chat messages") as {
          sender: { address: string };
          parts: { kind: string; text?: string }[];
        }[];
        const agentMessage = items.find(
          (item) =>
            item.sender.address === agentAddress &&
            item.parts.some((p) => p.kind === "text"),
        );
        if (agentMessage !== undefined) {
          const text = agentMessage.parts
            .filter((p) => p.kind === "text")
            .map((p) => p.text ?? "")
            .join("");
          if (USE_OLLAMA) {
            // A live Ollama instance actually answers: the opening
            // turn must be real prose, never the stub-key credential
            // error this suite otherwise proves against Anthropic.
            if (text.trim().length === 0 || /credential error/i.test(text)) {
              throw new Error(
                `expected a real Ollama greeting, got: ${JSON.stringify(agentMessage)}`,
              );
            }
            console.log(`  Myra's unprompted greeting (ollama): ${text}`);
          } else if (
            !text.includes("credential error") ||
            !/40[13]/.test(text)
          ) {
            throw new Error(
              `expected the agent's greeting-turn message to report the ` +
                `stub key's credential error, got: ${JSON.stringify(agentMessage)}`,
            );
          }
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `no agent-authored message landed in chat ${chatId} within ` +
              `60s of mint with zero user messages sent; messages seen: ` +
              `${JSON.stringify(items)}\nsidecar output:\n${sidecar.output()}`,
          );
        }
        await Bun.sleep(1000);
      }
    },
  );

  // ---- play loop -----------------------------------------------------
  let seenIds = new Set<string>();
  async function listAgentMessages(): Promise<
    { id: string; text: string; createdAt: string }[]
  > {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/channels/${chatId}/messages`,
      undefined,
      user.cookies,
    );
    const items = arrayField(res.data, "items", "list") as {
      id: string;
      createdAt: string;
      sender: { address: string };
      parts: { kind: string; text?: string }[];
    }[];
    return items
      .filter(
        (i) =>
          i.sender.address === agentAddress &&
          i.parts.some((p) => p.kind === "text"),
      )
      .map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        text: i.parts.map((p) => p.text ?? "").join(""),
      }));
  }
  for (const m of await listAgentMessages()) seenIds.add(m.id);
  for (const human of SCRIPT) {
    console.log(`\n>>> SAWYER: ${human}`);
    const sent = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/chat/channels/${chatId}/messages`,
      { parts: [{ kind: "text", text: human }] },
      user.cookies,
    );
    expectStatus("send", sent, 201);
    const t0 = Date.now();
    let answered = false;
    while (Date.now() - t0 < TURN_TIMEOUT_MS) {
      const fresh = (await listAgentMessages()).filter(
        (m) => !seenIds.has(m.id),
      );
      if (fresh.length > 0) {
        for (const m of fresh) {
          seenIds.add(m.id);
          console.log(
            `<<< MYRA (${Math.round((Date.now() - t0) / 1000)}s): ${m.text}`,
          );
        }
        // wait a little for follow-up messages in the same turn
        await Bun.sleep(4000);
        const more = (await listAgentMessages()).filter(
          (m) => !seenIds.has(m.id),
        );
        for (const m of more) {
          seenIds.add(m.id);
          console.log(`<<< MYRA (+): ${m.text}`);
        }
        answered = true;
        break;
      }
      await Bun.sleep(2000);
    }
    if (!answered) {
      console.log(`!!! no reply within ${TURN_TIMEOUT_MS / 1000}s`);
      const tail = (s: string) =>
        s
          .replace(/\x1b\[[0-9;]*m/g, "")
          .split("\n")
          .filter(
            (l) =>
              /WRN|ERR/.test(l) &&
              !/pack push failed|bootstrap retry|no live deployment anchor|heartbeat/.test(
                l,
              ),
          )
          .slice(-15)
          .join("\n");
      console.log(
        "--- hub ---\n" +
          tail(hub.output()) +
          "\n--- sidecar ---\n" +
          tail(sidecar.output()),
      );
      break;
    }
  }
  if (process.env["PLAY_DUMP"] === "1") {
    const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
    console.log("=== SIDECAR OUTPUT (filtered) ===");
    console.log(
      strip(sidecar.output())
        .split("\n")
        .filter(
          (l) =>
            /capabilit|tool|Tool|ERR/.test(l) &&
            !/hub·requests|pack push|bootstrap/.test(l),
        )
        .slice(-60)
        .join("\n"),
    );
  }
  // list routines + agents created in this tenant for the record
  const routines = await api(
    hub.baseUrl,
    "GET",
    `/api/tenants/${tenant.tenantId}/routines`,
    undefined,
    user.cookies,
  );
  console.log("\nROUTINES:", JSON.stringify(routines.data).slice(0, 800));
  const invitable = await api(
    hub.baseUrl,
    "GET",
    `/api/tenants/${tenant.tenantId}/chat/invitable`,
    undefined,
    user.cookies,
  );
  console.log("AGENTS:", JSON.stringify(invitable.data).slice(0, 800));
}

await main();
process.exit(0);
