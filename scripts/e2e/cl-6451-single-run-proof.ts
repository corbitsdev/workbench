// CL-6451's live proof, on one real stack: scratch database, real
// signup, real Ollama, nothing mocked. The bug it proves fixed: a
// participant's mention handle derives from its definition's display
// name ("myra"), while the workflow command registrar names commands
// after the definition's wire name ("assistant") — so `@assistant`
// used to fall past the known-handle guard into the command path and
// mint a SECOND run for an agent already in the room. Messages then
// fanned out to both runs, the original never parked, and the dispatch
// died at the supervisor's terminal-or-park backstop with the turn row
// stuck `running`.
//
//   1. Invite `assistant` into a workbench (run A, handle "myra"),
//      then send `@assistant ...` — the message posts as an ordinary
//      message (no command result), the room still has exactly ONE
//      agent participant, and the reply arrives as occurrence
//      `turn__0` of run A.
//   2. (CL-6453) A second `@assistant` message answers from the SAME
//      run as `turn__1` and recalls a fact stated in turn 1 — the
//      bootstrap exchange lives in the same stepId-keyed durable
//      history every later turn restores.
//
// Shares the boot/seed/mint scaffold with `cl-6329-turn-swap-proof.ts`.
//
// Usage:
//   E2E_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 \
//   E2E_OLLAMA_MODEL=llama3.1:8b \
//   DATABASE_URL=postgres://localhost:5432/wb6451proof_e2e \
//   bun run scripts/e2e/cl-6451-single-run-proof.ts
import { expect } from "bun:test";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createGitWorkflowPusher,
  DEFAULT_WORKFLOWS,
  seedTenant,
} from "../../packages/hub-client/src/index.ts";
import {
  createHubAPI,
  type ApiCall,
} from "../../packages/hub-api-client/src/index.ts";
import {
  findPersonalTenant,
  testAndPersistCredential,
  ensureSeeded,
} from "../../packages/onboarding/src/complete-credential.ts";
import {
  OLLAMA_PLACEHOLDER_SECRET,
  ollamaOpenAICompatBaseURL,
} from "../../packages/hub-client/src/credential-test.ts";
import {
  api,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  startHub,
  startSidecar,
  type HubHandle,
  type SpawnedApp,
} from "./harness.ts";

const configuredDatabaseUrl = e2eDatabaseUrl();
if (configuredDatabaseUrl === undefined) {
  throw new Error(
    "cl-6451-single-run-proof: DATABASE_URL is not set. This suite proves a " +
      "real boot and has nothing honest to assert without one.",
  );
}
const databaseUrl: string = configuredDatabaseUrl;

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"];
if (process.env["E2E_PROVIDER"] !== "ollama" || OLLAMA_BASE_URL === undefined) {
  throw new Error(
    "cl-6451-single-run-proof: set E2E_PROVIDER=ollama and OLLAMA_BASE_URL. " +
      "The proof requires a real completion model actually answering.",
  );
}
const ollamaBaseUrl = OLLAMA_BASE_URL;

const OLLAMA_MODEL = process.env["E2E_OLLAMA_MODEL"];
if (OLLAMA_MODEL === undefined || OLLAMA_MODEL === "") {
  throw new Error(
    "cl-6451-single-run-proof: set E2E_OLLAMA_MODEL to a completion model " +
      "the instance at OLLAMA_BASE_URL actually serves (see `ollama list`).",
  );
}
const proofModelSource = {
  provider: "openai-compatible",
  model: OLLAMA_MODEL,
  baseURL: ollamaOpenAICompatBaseURL(ollamaBaseUrl),
  apiKey: OLLAMA_PLACEHOLDER_SECRET,
} as const;

const TURN_TIMEOUT_MS = 300_000;

const tracked: SpawnedApp[] = [];
const tempDir = (prefix: string) => mkdtemp(pathJoin(tmpdir(), prefix));
const track = (app: SpawnedApp) => {
  tracked.push(app);
};
process.on("exit", () => {
  for (const a of tracked) {
    try {
      void a.stop();
    } catch {
      // Best-effort teardown: a child already gone is fine.
    }
  }
});

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
  const email = `cl6451-${crypto.randomUUID()}@example.invalid`;
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

async function main(): Promise<void> {
  const url = databaseUrl;

  await hop("database setup", async () => {
    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
  });

  const sidecarId = "cl6451-sidecar";
  const sidecarToken = crypto.randomUUID();
  await provisionSidecar(url, sidecarId, sidecarToken);

  const hub: HubHandle = await hop("hub boot", async () =>
    startHub({
      databaseUrl: url,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: await tempDir("cl6451-hub-data-"),
    }),
  );
  track(hub);
  const hubPort = Number(new URL(hub.baseUrl).port);

  const sidecar: SpawnedApp = startSidecar({
    hubPort,
    sidecarId,
    token: sidecarToken,
    dataDir: await tempDir("cl6451-sidecar-data-"),
  });
  track(sidecar);

  const hubApi: ApiCall = createHubAPI(hub.baseUrl);
  const pushWorkflow = createGitWorkflowPusher();

  const user = await hop("sign up", async () =>
    signUp(hub.baseUrl, "CL-6451 Proof"),
  );

  const provisioned = await hop("first-login provisioning", async () => {
    const res = await api(
      hub.baseUrl,
      "POST",
      "/api/onboarding/provision",
      { name: "CL-6451 Proof Bench" },
      user.cookies,
    );
    expectStatus("provision", res, 200);
    const data = res.data as { kind: string; tenantSlug: string };
    expect(data.kind).toBe("provisioned");
    return data;
  });

  const tenant = await hop("personal bench resolves", async () => {
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
  });

  const connected = await hop("connect Ollama", async () => {
    const result = await testAndPersistCredential({
      api: hubApi,
      cookies: user.cookies,
      hubUrl: hub.baseUrl,
      userId: user.userId,
      userEmail: user.email,
      provider: "ollama",
      apiKey: OLLAMA_PLACEHOLDER_SECRET,
      baseURLOverride: ollamaBaseUrl,
      pushWorkflow,
      log: () => undefined,
    });
    if (result.kind !== "connected") {
      throw new Error(
        `expected the key-path connect to succeed, got: ${JSON.stringify(result)}`,
      );
    }
    return result;
  });

  await hop("SETUP — the credential's own seed completes", async () => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        await ensureSeeded({
          api: hubApi,
          cookies: user.cookies,
          hubUrl: hub.baseUrl,
          pushWorkflow,
          log: () => undefined,
          tenant: connected,
          provider: "ollama",
          apiKey: OLLAMA_PLACEHOLDER_SECRET,
          baseURLOverride: ollamaBaseUrl,
        });
        return;
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await Bun.sleep(1000);
      }
    }
  });

  await hop(
    "SETUP — every default workflow deploys by source-ref",
    async () => {
      const deadline = Date.now() + 180_000;
      for (;;) {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before the seed finished; output:\n${sidecar.output()}`,
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
            model: proofModelSource,
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
    },
  );

  // No catalog narrowing here, unlike the CL-6329 proof: the seeded
  // `assistant` definition pins its own model (the connect flow's
  // choice), and disabling the other offerings can disable exactly the
  // model that pin names — this proof is about run identity, not model
  // selection, so every seeded offering stays launchable.

  const assistant = await hop(
    "SETUP — 'assistant' is invitable tenant-wide",
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
          const items = arrayField(res.data, "items", "invitable") as {
            id: string;
            name: string;
          }[];
          const found = items.find((item) => item.name === "assistant");
          if (found !== undefined) return found;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `"assistant" never became invitable: ${JSON.stringify(res.data)}`,
          );
        }
        await Bun.sleep(1000);
      }
    },
  );

  // A WORKBENCH, not a chat: the live bug fired in a room whose agent
  // arrived through the invite affordance and was then @named by its
  // definition's wire name.
  const workbenchId = await hop("SETUP — create a workbench", async () => {
    const res = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/chat/workbenches`,
      { kind: "workbench", name: "CL-6451 proof room" },
      user.cookies,
    );
    expectStatus("create workbench", res, 201);
    return stringField(res.data, "id", "create workbench");
  });

  async function listAgents(): Promise<{ address: string; handle: string }[]> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${workbenchId}/agents`,
      undefined,
      user.cookies,
    );
    expectStatus("read the room's agents", res, 200);
    return arrayField(res.data, "items", "room participants") as {
      address: string;
      handle: string;
    }[];
  }

  const agentAddress = await hop(
    "SETUP — invite `assistant` (run A)",
    async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenant.tenantId}/chat/workbenches/${workbenchId}/invite`,
          { definitionId: assistant.id },
          user.cookies,
        );
        if (res.status === 201) {
          return stringField(res.data, "address", "invite");
        }
        if (Date.now() > deadline) {
          throw new Error(`invite never landed: ${JSON.stringify(res.data)}`);
        }
        await Bun.sleep(1000);
      }
    },
  );
  const [agentRunId] = agentAddress.split("@");
  if (agentRunId === undefined) {
    throw new Error(`agent address is not a run address: ${agentAddress}`);
  }

  // The precondition that made the bug reachable: the participant's
  // handle is NOT the definition's wire name, so the known-handle guard
  // alone cannot recognize `@assistant` as this participant.
  const handle = (await listAgents()).find(
    (p) => p.address === agentAddress,
  )?.handle;
  if (handle === undefined) {
    throw new Error(`the invited agent is not on the room's participant list`);
  }
  if (handle === assistant.name) {
    throw new Error(
      `precondition broken: the handle (${handle}) equals the definition's ` +
        `wire name — this stack cannot reproduce the guard miss`,
    );
  }
  console.log(
    `  TRANSCRIPT — invited ${agentAddress} as @${handle}; ` +
      `the command name is "${assistant.name}"`,
  );

  type Turn = {
    id: string;
    agentAddress: string;
    childRunId: string;
    status: string;
    replyMessageId: string | null;
    error: string | null;
  };

  async function listTurns(): Promise<Turn[]> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${workbenchId}/turns`,
      undefined,
      user.cookies,
    );
    expectStatus("list the room's turns", res, 200);
    return arrayField(res.data, "items", "list turns") as Turn[];
  }

  async function listRoomMessages(): Promise<
    { id: string; address: string; text: string }[]
  > {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${workbenchId}/messages`,
      undefined,
      user.cookies,
    );
    expectStatus("list room messages", res, 200);
    const items = arrayField(res.data, "items", "list room messages") as {
      id: string;
      sender: { address: string };
      parts: { kind: string; text?: string }[];
    }[];
    return items.map((i) => ({
      id: i.id,
      address: i.sender.address,
      text: i.parts.map((p) => p.text ?? "").join(""),
    }));
  }

  async function sendAndAwaitTurn(
    text: string,
    expectedChildRunId: string,
  ): Promise<{ replyText: string }> {
    const res = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${workbenchId}/messages`,
      { parts: [{ kind: "text", text }] },
      user.cookies,
    );
    expectStatus(`send "${text.slice(0, 40)}"`, res, 201);
    // The heart of CL-6451: the `@assistant` message must NOT have been
    // intercepted as a workflow command.
    if (
      typeof res.data === "object" &&
      res.data !== null &&
      "command" in res.data
    ) {
      throw new Error(
        `the @${assistant.name} message was dispatched as a command — a ` +
          `second run was started: ${JSON.stringify(res.data)}`,
      );
    }

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      const turns = await listTurns();
      const settled = turns.find(
        (t) =>
          t.childRunId === expectedChildRunId &&
          t.status === "completed" &&
          t.replyMessageId !== null,
      );
      if (settled !== undefined) {
        expect(settled.agentAddress).toBe(agentAddress);
        const reply = (await listRoomMessages()).find(
          (m) => m.id === settled.replyMessageId,
        );
        const replyText = reply?.text ?? "";
        console.log(
          `  TRANSCRIPT — ${settled.childRunId}: ${replyText.slice(0, 160)}`,
        );
        return { replyText };
      }
      const failed = turns.find((t) => t.status === "failed");
      if (failed !== undefined) {
        throw new Error(
          `a turn failed instead of completing: ${JSON.stringify(failed)}\n` +
            `sidecar output:\n${sidecar.output()}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no completed ${expectedChildRunId} turn within the budget: ` +
            `${JSON.stringify(turns)}\nsidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(2000);
    }
  }

  await hop(
    "PROOF 1 — @assistant routes into run A, never a second run",
    async () => {
      await sendAndAwaitTurn(
        `@${assistant.name} My favorite color is teal. ` +
          `Acknowledge in one short sentence.`,
        "turn__0",
      );
      const agents = await listAgents();
      if (agents.length !== 1) {
        throw new Error(
          `the room grew a second agent participant: ` + JSON.stringify(agents),
        );
      }
      expect(agents[0]?.address).toBe(agentAddress);
    },
  );

  await hop(
    "PROOF 2 (CL-6453) — turn__1 rides the same run and remembers turn__0",
    async () => {
      const { replyText } = await sendAndAwaitTurn(
        `@${assistant.name} What is my favorite color? ` +
          `Answer with just the color name.`,
        "turn__1",
      );
      if (!/teal/i.test(replyText)) {
        throw new Error(
          `turn__1's reply does not recall turn__0's fact ("teal"): ` +
            `"${replyText}" — the bootstrap exchange is missing from the ` +
            `durable history`,
        );
      }
      const agents = await listAgents();
      expect(agents).toHaveLength(1);
    },
  );

  console.log("\nBoth CL-6451/CL-6453 proofs passed.");
}

await main();
process.exit(0);
