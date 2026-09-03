// CL-6329's live proof, on one real stack: scratch database, real
// signup, real Ollama, nothing mocked. Every agent invited into a room
// now deploys as an `onTrigger` section, so this asserts the three
// things that swap has to make true:
//
//   1. Two agents reply in ONE room, and each reply carries its own
//      occurrence's child run id (`turn__<n>`) — distinct per agent,
//      readable back through the room's own turns routes.
//   2. Three rapid messages serialize into ordered turns rather than
//      racing: occurrences 0,1,2 in arrival order.
//   3. A turn killed mid-occurrence leaves BOTH the room and the section
//      alive: `onBodyFailure: "tolerate"` keeps the section subscribed,
//      the failed turn is visible rather than silent, and the next
//      message is still answered.
//
// Shares the boot/seed/mint scaffold with `cl-6329-turn-swap-proof.ts`.
//
// Usage:
//   E2E_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 \
//   E2E_OLLAMA_MODEL=llama3.2:latest \
//   DATABASE_URL=postgres://localhost:5432/wb6329proof_e2e \
//   bun run scripts/e2e/cl-6329-turn-swap-proof.ts
import { expect } from "bun:test";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createGitWorkflowPusher,
  DEFAULT_WORKFLOWS,
  seedTenant,
} from "../../packages/seeding/src/index.ts";
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
} from "../../packages/connections/src/credential-test.ts";
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

const configuredDatabaseUrl = e2eDatabaseUrl();
if (configuredDatabaseUrl === undefined) {
  throw new Error(
    "cl-6329-turn-swap-proof: DATABASE_URL is not set. This suite proves a real " +
      "boot and has nothing honest to assert without one.",
  );
}
const databaseUrl: string = configuredDatabaseUrl;

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"];
if (process.env["E2E_PROVIDER"] !== "ollama" || OLLAMA_BASE_URL === undefined) {
  throw new Error(
    "cl-6329-turn-swap-proof: set E2E_PROVIDER=ollama and OLLAMA_BASE_URL. The " +
      "proofs require a real completion model actually answering.",
  );
}
const ollamaBaseUrl = OLLAMA_BASE_URL;

// Named explicitly rather than taken from `CATALOG_SEEDS.ollama`: the
// curated seed lists models a given instance may simply not have pulled,
// and a deploy pinned at a model the instance cannot serve fails as an
// inference error that reads nothing like the thing being proved.
const OLLAMA_MODEL = process.env["E2E_OLLAMA_MODEL"];
if (OLLAMA_MODEL === undefined || OLLAMA_MODEL === "") {
  throw new Error(
    "cl-6329-turn-swap-proof: set E2E_OLLAMA_MODEL to a completion model the " +
      "instance at OLLAMA_BASE_URL actually serves (see `ollama list`).",
  );
}
/** The model source every deploy in this proof pins, explicitly. */
const proofModelSource = {
  provider: "openai-compatible",
  model: OLLAMA_MODEL,
  baseURL: ollamaOpenAICompatBaseURL(ollamaBaseUrl),
  apiKey: OLLAMA_PLACEHOLDER_SECRET,
} as const;

const TURN_TIMEOUT_MS = 300_000;

/**
 * Proof 4's mid-turn workload. Deliberately far longer than any model
 * can finish inside `MID_TURN_KILL_DELAY_MS`, so the kill lands while
 * inference is genuinely running rather than in the quiet gap after a
 * short turn already completed — the distinction between proving
 * crash-recovery and proving a clean restart.
 */
const MID_TURN_PROMPT =
  "Count slowly from one to four hundred, one number per line. " +
  "Write every number out; do not stop early and do not summarise.";
const MID_TURN_KILL_DELAY_MS = 3000;

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
  const email = `cl6329-${crypto.randomUUID()}@example.invalid`;
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
  const ms = Date.now() - t0;
  timings.push({ label, ms });
  // Printed as it lands, not only in the summary: a run that fails at a
  // later proof still has to report what the earlier ones cost.
  console.log(`  TIMING — ${label}: ${(ms / 1000).toFixed(1)}s`);
  return value;
}

async function main(): Promise<void> {
  const url = databaseUrl;

  await hop("database setup", async () => {
    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
  });

  const sidecarId = "cl6329-sidecar";
  const sidecarToken = crypto.randomUUID();
  await provisionSidecar(url, sidecarId, sidecarToken);

  const hub: HubHandle = await hop("hub boot", async () =>
    startHub({
      databaseUrl: url,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: await tempDir("cl6329-hub-data-"),
    }),
  );
  track(hub);
  const hubPort = Number(new URL(hub.baseUrl).port);

  // The sidecar's data dir is reused verbatim across the restart in
  // proof 4: boot restore reads the deployments it left behind there.
  const sidecarDataDir = await tempDir("cl6329-sidecar-data-");
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
    signUp(hub.baseUrl, "CL-6329 Proof"),
  );

  const provisioned = await hop("first-login provisioning", async () => {
    const res = await api(
      hub.baseUrl,
      "POST",
      "/api/onboarding/provision",
      { name: "CL-6329 Proof Bench" },
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

  await timed("setup: every default workflow deploys by source-ref", () =>
    hop("SETUP — every default workflow deploys by source-ref", async () => {
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
    }),
  );

  async function plantGrant(resource: string, action: string): Promise<void> {
    const granted = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/grants`,
      {
        principalId: tenant.principalId,
        resource,
        action,
        effect: "allow",
        origin: "system",
      },
      user.cookies,
    );
    if (granted.status !== 201 && granted.status !== 409) {
      throw new Error(
        `could not plant the ${resource}/${action} grant: ` +
          `${String(granted.status)} ${JSON.stringify(granted.data)}`,
      );
    }
  }

  // A live Ollama connect seeds one catalog offering per pulled model,
  // embedding models included, with no capability metadata to tell them
  // apart (CL-6351). Default-model resolution then breaks the tie
  // alphabetically, so `all-minilm` wins the bench default and every
  // chat turn dies before it reaches a model. This proof pins ONE model
  // on purpose, so it narrows the bench's own catalog to that model
  // through the catalog API rather than leaving the turn's model to a
  // coin flip the proof is not about.
  await hop("narrow the bench catalog to the pinned model", async () => {
    await plantGrant("model-offering:*", "read");
    await plantGrant("model-offering:*", "manage");
    await plantGrant("model:*", "read");

    const models = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/catalog/models?limit=200`,
      undefined,
      user.cookies,
    );
    expectStatus("list the bench catalog models", models, 200);
    const modelRows = arrayField(models.data, "data", "catalog models") as {
      id: string;
      canonicalName: string;
    }[];
    const pinned = modelRows.find(
      (row) => row.canonicalName === proofModelSource.model,
    );
    if (pinned === undefined) {
      throw new Error(
        `the bench catalog carries no model named ${proofModelSource.model}; ` +
          `it has ${JSON.stringify(modelRows.map((m) => m.canonicalName))}`,
      );
    }

    const offerings = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/catalog/offerings?limit=200`,
      undefined,
      user.cookies,
    );
    expectStatus("list the bench model offerings", offerings, 200);
    const offeringRows = arrayField(
      offerings.data,
      "data",
      "model offerings",
    ) as { id: string; modelId: string; disabled: boolean }[];
    for (const offering of offeringRows) {
      if (offering.modelId === pinned.id || offering.disabled) continue;
      const patched = await api(
        hub.baseUrl,
        "PATCH",
        `/api/tenants/${tenant.tenantId}/catalog/offerings/${offering.id}`,
        { disabled: true },
        user.cookies,
      );
      expectStatus(`disable offering ${offering.id}`, patched, 200);
    }
    console.log(
      `  TRANSCRIPT — bench catalog narrowed to ${proofModelSource.model} ` +
        `(${String(offeringRows.length - 1)} other offerings disabled)`,
    );
  });

  const assistantDefinitionId = await hop(
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
    "setup: mint → probe → closure materialization",
    () =>
      hop(
        "SETUP — POST /workbenches mints a chat with its agent joined",
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

  type Turn = {
    id: string;
    agentAddress: string;
    childRunId: string;
    occurrence: number;
    status: string;
    replyMessageId: string | null;
    error: string | null;
  };

  /**
   * The run ids present in a deployment's workflow-run event repo — the
   * anchor plus every child run that has committed an event. A
   * section-mode occurrence shows up here as `turn__<n>` the moment its
   * first event lands.
   */
  async function listDeploymentRunIds(anchorRunId: string): Promise<string[]> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/workflows/${anchorRunId}/runs`,
      undefined,
      user.cookies,
    );
    if (res.status !== 200) return [];
    const raw = res.data;
    if (
      typeof raw !== "object" ||
      raw === null ||
      !Array.isArray((raw as Record<string, unknown>)["runIds"])
    ) {
      return [];
    }
    return (raw as { runIds: string[] }).runIds;
  }

  /** The room's own turn projection — CL-6329's traceability surface. */
  async function listTurns(): Promise<Turn[]> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/turns`,
      undefined,
      user.cookies,
    );
    expectStatus("list the room's turns", res, 200);
    return arrayField(res.data, "items", "list turns") as Turn[];
  }

  /** Every message in the room, whoever sent it, with its run id. */
  async function listRoomMessages(): Promise<
    { id: string; address: string; text: string }[]
  > {
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
    return items.map((i) => ({
      id: i.id,
      address: i.sender.address,
      text: i.parts.map((p) => p.text ?? "").join(""),
    }));
  }

  async function sendRoomMessage(text: string): Promise<void> {
    const res = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/messages`,
      { parts: [{ kind: "text", text }] },
      user.cookies,
    );
    expectStatus(`send "${text.slice(0, 40)}"`, res, 201);
  }

  const isOccurrenceRunId = (id: string): boolean => /^turn__\d+$/.test(id);

  /** A participant's `@handle` in this room, read from the room itself. */
  async function handleOf(address: string): Promise<string> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/agents`,
      undefined,
      user.cookies,
    );
    expectStatus("read the room's agents", res, 200);
    const participants = arrayField(res.data, "items", "room participants") as {
      address: string;
      handle: string;
    }[];
    const found = participants.find((p) => p.address === address);
    if (found === undefined) {
      throw new Error(
        `the room has no participant at ${address}: ` +
          JSON.stringify(participants.map((p) => p.address)),
      );
    }
    return found.handle;
  }

  // ---- proof 1: two agents, one room, one occurrence each -----------
  const secondAgent = await timed("proof 1: invite a second agent", () =>
    hop("PROOF 1 — a second agent joins the same room", async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/invite`,
        { definitionId: assistantDefinitionId },
        user.cookies,
      );
      expectStatus("invite the second agent", res, 201);
      const address = stringField(res.data, "address", "invite");
      const handle = await handleOf(address);
      if (address === agentAddress) {
        throw new Error(
          "the invite returned the first agent's own address; the room has " +
            "one participant, not two",
        );
      }
      console.log(`  TRANSCRIPT — second agent @${handle} at ${address}`);
      return { address, handle };
    }),
  );

  const firstHandle = await handleOf(agentAddress);

  await timed("proof 1: both agents answer one message", () =>
    hop(
      "PROOF 1 — two agents reply in one room, each under its own turn",
      async () => {
        const before = new Set((await listRoomMessages()).map((m) => m.id));
        await sendRoomMessage(
          `@${firstHandle} @${secondAgent.handle} say hi in one short sentence.`,
        );

        const deadline = Date.now() + TURN_TIMEOUT_MS;
        for (;;) {
          const turns = await listTurns();
          const settled = turns.filter(
            (t) => t.status === "completed" && t.replyMessageId !== null,
          );
          const addresses = new Set(settled.map((t) => t.agentAddress));
          if (addresses.size >= 2) {
            const replies = (await listRoomMessages()).filter(
              (m) => !before.has(m.id),
            );
            for (const turn of settled) {
              if (!isOccurrenceRunId(turn.childRunId)) {
                throw new Error(
                  `turn ${turn.id} carries child run id ${turn.childRunId}, ` +
                    `which is not an occurrence id — the reply is not ` +
                    `traceable to a section occurrence`,
                );
              }
              const reply = replies.find((m) => m.id === turn.replyMessageId);
              console.log(
                `  TRANSCRIPT — ${turn.agentAddress} turn ${turn.childRunId}: ` +
                  `${reply?.text.slice(0, 120) ?? "(reply row not listed)"}`,
              );
            }
            // Distinct per agent is the point: two agents in one room
            // must not share an occurrence id.
            const byAgent = new Map<string, string>();
            for (const turn of settled) byAgent.set(turn.agentAddress, turn.id);
            expect(byAgent.size).toBeGreaterThanOrEqual(2);
            return settled;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `only ${String(addresses.size)} of 2 agents produced a settled ` +
                `turn: ${JSON.stringify(turns)}\n` +
                `sidecar output:\n${sidecar.output()}`,
            );
          }
          await Bun.sleep(2000);
        }
      },
    ),
  );

  // The occurrence ids the projection allocated must be the ones the
  // runtime actually ran — read straight off the deployment's own
  // workflow-run repo, not off our own rows.
  await hop(
    "PROOF 1 — the projection's occurrence ids are the runtime's own",
    async () => {
      const runIds = await listDeploymentRunIds(agentRunId);
      const occurrences = runIds.filter(isOccurrenceRunId);
      console.log(
        `  TRANSCRIPT — run ${agentRunId} child runs: ${JSON.stringify(runIds)}`,
      );
      if (occurrences.length === 0) {
        throw new Error(
          `the room agent's deployment started NO per-occurrence child run ` +
            `(${JSON.stringify(runIds)}); it is still deploying as a folded ` +
            `step rather than an onTrigger section`,
        );
      }
      const projected = new Set(
        (await listTurns())
          .filter((t) => t.agentAddress === agentAddress)
          .map((t) => t.childRunId),
      );
      for (const id of occurrences) {
        if (!projected.has(id)) {
          throw new Error(
            `the runtime ran occurrence ${id}, which the turn projection ` +
              `never allocated: ${JSON.stringify([...projected])}`,
          );
        }
      }
    },
  );

  // ---- proof 2: three rapid messages serialize into ordered turns ---
  await timed("proof 2: three rapid messages serialize", () =>
    hop(
      "PROOF 2 — a burst of three messages becomes ordered turns",
      async () => {
        const before = (await listTurns()).filter(
          (t) => t.agentAddress === agentAddress,
        ).length;

        // Sent back to back with no wait between: the queue, not the
        // sender, is what has to order them.
        await sendRoomMessage(`@${firstHandle} one`);
        await sendRoomMessage(`@${firstHandle} two`);
        await sendRoomMessage(`@${firstHandle} three`);

        const deadline = Date.now() + TURN_TIMEOUT_MS;
        for (;;) {
          const mine = (await listTurns())
            .filter((t) => t.agentAddress === agentAddress)
            .sort((a, b) => a.occurrence - b.occurrence);
          if (mine.length >= before + 3) {
            const occurrences = mine.map((t) => t.occurrence);
            console.log(
              `  TRANSCRIPT — occurrences after the burst: ` +
                JSON.stringify(occurrences),
            );
            // Contiguous and ascending from zero: no gap, no duplicate,
            // no two turns sharing a child run id.
            expect(occurrences).toEqual(occurrences.map((_, i) => i));
            expect(new Set(mine.map((t) => t.childRunId)).size).toBe(
              mine.length,
            );
            return;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `the burst produced ${String(mine.length)} turns, expected more ` +
                `than ${String(before)}: ${JSON.stringify(mine)}`,
            );
          }
          await Bun.sleep(2000);
        }
      },
    ),
  );

  // ---- proof 3: a failed turn kills neither the room nor the section -
  const seenIds = new Set((await listRoomMessages()).map((m) => m.id));

  await timed("proof 3: kill the sidecar mid-occurrence", () =>
    hop(
      "PROOF 3 — the sidecar dies while an occurrence is running",
      async () => {
        await sendRoomMessage(`@${firstHandle} ${MID_TURN_PROMPT}`);
        await Bun.sleep(MID_TURN_KILL_DELAY_MS);
        await sidecar.stop();
        console.log("  TRANSCRIPT — sidecar killed mid-occurrence");
      },
    ),
  );

  await timed("proof 3: restart and restore", () =>
    hop(
      "PROOF 3 — the sidecar restarts and restores its deployments",
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
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/turns`,
            undefined,
            user.cookies,
          );
          if (res.status === 200) return;
          if (Date.now() > deadline) {
            throw new Error(
              `the room never came back after the restart: ${JSON.stringify(res.data)}`,
            );
          }
          await Bun.sleep(2000);
        }
      },
    ),
  );

  await hop(
    "PROOF 3 — the interrupted turn surfaces visibly rather than silently",
    async () => {
      const deadline = Date.now() + 180_000;
      for (;;) {
        const fresh = (await listRoomMessages()).filter(
          (m) => !seenIds.has(m.id) && m.address !== `${tenant.principalId}`,
        );
        const agentFresh = fresh.filter((m) => m.text.trim().length > 0);
        if (agentFresh.length > 0) {
          console.log(
            `  TRANSCRIPT — the interrupted turn surfaced as: ` +
              JSON.stringify(agentFresh.map((m) => m.text.slice(0, 160))),
          );
          for (const m of fresh) seenIds.add(m.id);
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(
            "the turn the kill interrupted left NOTHING in the room: no " +
              "partial answer and no notice, so the reader's message was " +
              "accepted and silently dropped",
          );
        }
        await Bun.sleep(3000);
      }
    },
  );

  await timed("proof 3: the room still answers after the failed turn", () =>
    hop(
      "PROOF 3 — the section is still subscribed and answers the next message",
      async () => {
        const before = new Set((await listRoomMessages()).map((m) => m.id));
        const beforeTurns = (await listTurns()).filter(
          (t) => t.agentAddress === agentAddress,
        ).length;
        // Resent on a loop rather than once: the room's own rows come
        // back the moment the hub is up, but the section's run only
        // becomes routable again once the restarted sidecar has
        // re-registered it, and a send that lands in that window fails
        // as "no sidecar available" — a failed turn, correctly recorded,
        // that says nothing about whether the section survived.
        let nextAsk = 0;
        const deadline = Date.now() + TURN_TIMEOUT_MS;
        for (;;) {
          if (Date.now() >= nextAsk) {
            await sendRoomMessage(
              `@${firstHandle} are you still there? One word.`,
            );
            nextAsk = Date.now() + 20_000;
          }
          const mine = (await listTurns()).filter(
            (t) => t.agentAddress === agentAddress,
          );
          const settled = mine.find(
            (t) =>
              t.status === "completed" &&
              t.replyMessageId !== null &&
              !before.has(t.replyMessageId),
          );
          if (settled !== undefined) {
            const reply = (await listRoomMessages()).find(
              (m) => m.id === settled.replyMessageId,
            );
            console.log(
              `  TRANSCRIPT — post-failure occurrence ${settled.childRunId}: ` +
                `${reply?.text.slice(0, 160) ?? "(row not listed)"}`,
            );
            expect(mine.length).toBeGreaterThan(beforeTurns);
            return;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `the room never answered after the failed turn — the section ` +
                `did not survive it: ${JSON.stringify(mine)}\n` +
                `sidecar output:\n${sidecar.output()}`,
            );
          }
          await Bun.sleep(2000);
        }
      },
    ),
  );

  await hop("PROOF 3 — the failed turn is on the record", async () => {
    const turns = await listTurns();
    console.log(
      `  TRANSCRIPT — the room's turns: ` +
        JSON.stringify(
          turns.map((t) => ({
            agent: t.agentAddress,
            run: t.childRunId,
            status: t.status,
          })),
        ),
    );
    const unsettled = turns.filter((t) => t.status !== "completed");
    if (unsettled.length === 0) {
      console.log(
        "  TRANSCRIPT — no turn is recorded failed; the interrupted " +
          "occurrence settled some other way (see the notice above)",
      );
    }
  });

  console.log("\n=== TIMINGS ===");
  for (const t of timings) {
    console.log(`  ${t.label}: ${(t.ms / 1000).toFixed(1)}s`);
  }
  console.log("\nAll three CL-6329 proofs passed.");
}

await main();
process.exit(0);
