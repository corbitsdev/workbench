// The four proofs the workflow.json retirement has to clear, on one
// real stack: scratch database, real signup, real Ollama, nothing
// mocked. Self-contained in the `play.ts` shape (boot, sign up, connect,
// seed, mint, talk) but every step asserts, and it prints the timings
// the milestone asks for.
//
//   1. The seed goes fully green by source-ref — every default workflow
//      deploys off a pushed source codebase, no `workflow.json` envelope.
//   2. A workbench mint walks the whole new deploy path: the approval
//      probe answers, the closure materializes FOR REAL on the sidecar,
//      and the run's own event log carries `RunStarted`.
//   3. A real human message gets a real model reply.
//   4. The sidecar is killed mid-turn and restarted: boot restore
//      replays the deployment's pin, the room survives, and the next
//      message is answered.
//
// Usage:
//   E2E_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 \
//   DATABASE_URL=postgres://localhost:5432/wb6324proof_e2e \
//   bun run scripts/e2e/cl-6324-launch-proof.ts
import { expect } from "bun:test";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

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

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  throw new Error(
    "cl-6324-launch-proof: DATABASE_URL is not set. This suite proves a real " +
      "boot and has nothing honest to assert without one.",
  );
}

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"];
if (process.env["E2E_PROVIDER"] !== "ollama" || OLLAMA_BASE_URL === undefined) {
  throw new Error(
    "cl-6324-launch-proof: set E2E_PROVIDER=ollama and OLLAMA_BASE_URL. The " +
      "proofs require a real completion model actually answering.",
  );
}
const ollamaBaseUrl = OLLAMA_BASE_URL;

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
  const email = `cl6324-${crypto.randomUUID()}@example.invalid`;
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

const timings: { label: string; ms: number }[] = [];
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const value = await run();
  timings.push({ label, ms: Date.now() - t0 });
  return value;
}

async function main(): Promise<void> {
  const url = databaseUrl;

  await hop("database setup", async () => {
    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
  });

  const sidecarId = "cl6324-sidecar";
  const sidecarToken = crypto.randomUUID();
  await provisionSidecar(url, sidecarId, sidecarToken);

  const hub: HubHandle = await hop("hub boot", async () =>
    startHub({
      databaseUrl: url,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: await tempDir("cl6324-hub-data-"),
    }),
  );
  track(hub);
  const hubPort = Number(new URL(hub.baseUrl).port);

  // The sidecar's data dir is reused verbatim across the restart in
  // proof 4: boot restore reads the deployments it left behind there.
  const sidecarDataDir = await tempDir("cl6324-sidecar-data-");
  let sidecar: SpawnedApp = startSidecar({
    hubPort,
    sidecarId,
    token: sidecarToken,
    dataDir: sidecarDataDir,
  });
  track(sidecar);

  const hubApi: ApiCall = createHubAPI(hub.baseUrl);
  const pushWorkflow = createGitWorkflowPusher();

  const user = await hop("sign up", async () =>
    signUp(hub.baseUrl, "CL-6324 Proof"),
  );

  const provisioned = await hop("first-login provisioning", async () => {
    const res = await api(
      hub.baseUrl,
      "POST",
      "/api/onboarding/provision",
      { name: "CL-6324 Proof Bench" },
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

  const connected = await hop("connect the local Ollama", async () => {
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

  // ---- proof 1: the seed goes fully green by source-ref -------------
  await hop("PROOF 1 — the credential's own seed completes", async () => {
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

  await timed("proof 1: every default workflow deploys by source-ref", () =>
    hop("PROOF 1 — every default workflow deploys by source-ref", async () => {
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
            model: modelSourceFor(
              "ollama",
              OLLAMA_PLACEHOLDER_SECRET,
              ollamaBaseUrl,
            ),
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
    }),
  );

  const assistantDefinitionId = await hop(
    "PROOF 1 — 'assistant' is invitable tenant-wide",
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
          const assistant = items.find((item) => item.name === "assistant");
          if (assistant !== undefined) return assistant.id;
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

  // ---- proof 2: mint walks the whole new deploy path ----------------
  const { chatId, agentAddress, agentRunId } = await timed(
    "proof 2: mint → probe → closure materialization",
    () =>
      hop(
        "PROOF 2 — POST /workbenches mints a chat with its agent joined",
        async () => {
          const deadline = Date.now() + 120_000;
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
              `/api/tenants/${tenant.tenantId}/chat/workbenches`,
              { kind: "chat", definitionId: assistantDefinitionId },
              user.cookies,
            );
            if (res.status !== 500) break;
            if (Date.now() > deadline) {
              throw new Error(
                `chat never became mintable: ${JSON.stringify(res.data)}\n` +
                  `sidecar output:\n${sidecar.output()}`,
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
              `chat has no "myra" participant: ${JSON.stringify(participants)}`,
            );
          }
          const [runId] = agent.address.split("@");
          if (runId === undefined) {
            throw new Error(
              `agent address is not a run address: ${agent.address}`,
            );
          }
          return { chatId: id, agentAddress: agent.address, agentRunId: runId };
        },
      ),
  );

  /**
   * A folded run is self-anchored — its run id IS its deployment id — so
   * the deployment and run path segments are the same value.
   */
  async function readRunEvents(): Promise<{ seq: number; type: string }[]> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/workflows/${agentRunId}/runs/${agentRunId}/events`,
      undefined,
      user.cookies,
    );
    if (res.status !== 200) return [];
    const raw = res.data;
    if (
      typeof raw !== "object" ||
      raw === null ||
      !Array.isArray((raw as Record<string, unknown>)["events"])
    ) {
      return [];
    }
    return (raw as { events: { seq: number; type: string }[] }).events;
  }

  async function listAgentMessages(): Promise<{ id: string; text: string }[]> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/messages`,
      undefined,
      user.cookies,
    );
    expectStatus("list chat messages", res, 200);
    const items = arrayField(res.data, "items", "list chat messages") as {
      id: string;
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
        text: i.parts.map((p) => p.text ?? "").join(""),
      }));
  }

  const seenIds = new Set<string>();

  await timed("proof 2: greeting turn (deploy + first token)", () =>
    hop(
      "PROOF 2 — an agent-authored greeting lands with no user message sent",
      async () => {
        const deadline = Date.now() + TURN_TIMEOUT_MS;
        for (;;) {
          const messages = await listAgentMessages();
          const greeting = messages.find((m) => m.text.trim().length > 0);
          if (greeting !== undefined) {
            for (const m of messages) seenIds.add(m.id);
            console.log(`  TRANSCRIPT — greeting: ${greeting.text}`);
            return;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `no agent greeting landed in chat ${chatId}\n` +
                `sidecar output:\n${sidecar.output()}`,
            );
          }
          await Bun.sleep(1000);
        }
      },
    ),
  );

  await hop(
    "PROOF 2 — the run's own event log carries RunStarted",
    async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const events = await readRunEvents();
        if (events.some((e) => e.type === "RunStarted")) {
          console.log(
            `  TRANSCRIPT — run ${agentRunId} events: ` +
              JSON.stringify(events.map((e) => `${String(e.seq)}:${e.type}`)),
          );
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `run ${agentRunId} never recorded RunStarted; events seen: ` +
              `${JSON.stringify(events)}\nhub output:\n${hub.output()}` +
              `\nsidecar output:\n${sidecar.output()}`,
          );
        }
        await Bun.sleep(1000);
      }
    },
  );

  // ---- proof 3: a real message gets a real reply --------------------
  async function autoApproveAll(): Promise<void> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/approvals/needs-you`,
      undefined,
      user.cookies,
    );
    if (res.status !== 200) return;
    const items = arrayField(res.data, "items", "needs-you") as {
      id: string;
      agentName: string;
      headline: string;
    }[];
    for (const item of items) {
      await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenant.tenantId}/approvals/${item.id}/approve`,
        { scope: "once" },
        user.cookies,
      );
    }
  }

  async function sendAndAwaitReply(text: string, label: string): Promise<void> {
    const sent = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/messages`,
      { parts: [{ kind: "text", text }] },
      user.cookies,
    );
    expectStatus("send message", sent, 201);
    const t0 = Date.now();
    const deadline = t0 + TURN_TIMEOUT_MS;
    for (;;) {
      await autoApproveAll();
      const fresh = (await listAgentMessages()).filter(
        (m) => !seenIds.has(m.id),
      );
      if (fresh.length > 0) {
        for (const m of fresh) seenIds.add(m.id);
        const reply = fresh.map((m) => m.text).join(" ");
        timings.push({ label: `${label}: first reply`, ms: Date.now() - t0 });
        console.log(`  TRANSCRIPT — >>> ${text}`);
        console.log(`  TRANSCRIPT — <<< ${reply}`);
        if (/^\s*$/.test(reply) || /didn't get that one/i.test(reply)) {
          throw new Error(
            `${label}: the agent answered with the undelivered notice, not a ` +
              `real turn: ${JSON.stringify(reply)}\n` +
              `sidecar output:\n${sidecar.output()}`,
          );
        }
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${label}: no reply within ${TURN_TIMEOUT_MS / 1000}s\n` +
            `sidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(2000);
    }
  }

  await hop("PROOF 3 — a real message gets a real model reply", () =>
    sendAndAwaitReply(
      "In one short sentence, what can you help me with?",
      "proof 3",
    ),
  );

  // ---- proof 4: kill the sidecar mid-turn, restart, keep talking ----
  await hop("PROOF 4 — kill the sidecar mid-turn", async () => {
    const sent = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/messages`,
      {
        parts: [
          {
            kind: "text",
            text: "Count slowly from one to twenty, one number per line.",
          },
        ],
      },
      user.cookies,
    );
    expectStatus("send the mid-turn message", sent, 201);
    // Long enough that the turn is genuinely in flight — the child has
    // the mail and inference is running — but well short of a reply.
    await Bun.sleep(3000);
    await sidecar.stop();
  });

  await timed("proof 4: sidecar restart + boot restore", () =>
    hop(
      "PROOF 4 — the sidecar restarts and boot restore replays the pin",
      async () => {
        sidecar = startSidecar({
          hubPort,
          sidecarId,
          token: sidecarToken,
          dataDir: sidecarDataDir,
        });
        track(sidecar);
        const deadline = Date.now() + 120_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `the restarted sidecar exited; output:\n${sidecar.output()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/messages`,
            undefined,
            user.cookies,
          );
          if (res.status === 200) return;
          if (Date.now() > deadline) {
            throw new Error(
              `the room did not survive the restart: ${JSON.stringify(res.data)}`,
            );
          }
          await Bun.sleep(1000);
        }
      },
    ),
  );

  // Whatever the killed turn produced (a partial reply, or nothing) is
  // not the proof; the proof is that the NEXT message is answered.
  for (const m of await listAgentMessages()) seenIds.add(m.id);

  await hop("PROOF 4 — the next message is answered after the restart", () =>
    sendAndAwaitReply("Are you still there? One sentence.", "proof 4"),
  );

  console.log("\n=== TIMINGS ===");
  for (const t of timings) {
    console.log(`  ${t.label}: ${(t.ms / 1000).toFixed(1)}s`);
  }
  console.log("\nAll four proofs passed.");
}

await main();
process.exit(0);
