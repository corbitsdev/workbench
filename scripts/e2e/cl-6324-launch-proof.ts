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
//      and the run brackets a real per-message turn. Asserted in BOTH
//      deploy shapes, because the bracket is a different durable
//      artefact in each — see `PROOF 2` and `PROOF 2b` below.
//   3. A real human message gets a real model reply.
//   4. The sidecar is killed mid-turn and restarted: boot restore
//      replays the deployment's pin, the room survives, and the next
//      message is answered — in both shapes.
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
import { WORKFLOW_SOURCE_ENTRY } from "../../packages/workflow-source/src/index.ts";
import {
  agentRuntimeTurnRunId,
  buildAgentRuntimeWorkflow,
} from "../../packages/agent-runtime/src/index.ts";
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
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "./harness.ts";

const configuredDatabaseUrl = e2eDatabaseUrl();
if (configuredDatabaseUrl === undefined) {
  throw new Error(
    "cl-6324-launch-proof: DATABASE_URL is not set. This suite proves a real " +
      "boot and has nothing honest to assert without one.",
  );
}
const databaseUrl: string = configuredDatabaseUrl;

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"];
if (process.env["E2E_PROVIDER"] !== "ollama" || OLLAMA_BASE_URL === undefined) {
  throw new Error(
    "cl-6324-launch-proof: set E2E_PROVIDER=ollama and OLLAMA_BASE_URL. The " +
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
    "cl-6324-launch-proof: set E2E_OLLAMA_MODEL to a completion model the " +
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

  /**
   * The number of completed per-message brackets the hub has durably
   * recorded for this tenant. `@corbits/insights`' latency tracker opens
   * a row on the `message.run.started` AGENT event and commits it on
   * `message.run.ended`, so a non-zero sample count is durable,
   * HTTP-observable evidence that the bracket both opened and closed —
   * the only such evidence a folded `step`-mode turn produces.
   */
  async function completedTurnBrackets(): Promise<number> {
    const res = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenant.tenantId}/insights/latency`,
      undefined,
      user.cookies,
    );
    expectStatus("read the turn-latency summary", res, 200);
    const total = (res.data as { total?: { samples?: unknown } }).total;
    if (typeof total?.samples !== "number") {
      throw new Error(
        `the latency summary carries no total.samples: ${JSON.stringify(res.data)}`,
      );
    }
    return total.samples;
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

  // The joining greeting is CANNED copy `@corbits/chat` posts from the
  // agent's address (`workbench-service.ts`'s welcome line), not a model
  // turn — so it times the room and the participant join, and nothing
  // about inference. The deploy path's first real token is proof 3's.
  await timed("proof 2: canned join greeting lands (room + participant)", () =>
    hop(
      "PROOF 2 — the minted chat carries its agent and its canned greeting",
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

  // A folded `step`-mode run is ONE unbounded step servicing every
  // inbound mail, so its per-message bracket is the `message.run.started`
  // AGENT event (`packages/folded-runs/src/agent-events.ts`) — an
  // in-process sidecar frame the hub consumes and never commits to the
  // run's durable workflow event log. Asserting a workflow-host
  // `RunStarted` per message here would be asserting the section shape's
  // contract against the step shape's run, which is why the earlier
  // revision of this proof hung on it.
  //
  // What IS durable and HTTP-observable for a step-mode turn is the reply
  // row the completed bracket wrote, already asserted above. What this
  // step adds is the shape fact itself, stated as a falsifiable
  // assertion rather than a footnote: a step-mode run brackets NO
  // per-occurrence child run. `PROOF 2b` asserts the opposite for the
  // section shape, and the two together are the real evidence.
  await hop(
    "PROOF 2 — a step-mode run's durable bracket is its reply row, and it starts no per-occurrence child run",
    async () => {
      const events = await readRunEvents();
      const childRunIds = await listDeploymentRunIds(agentRunId);
      console.log(
        `  TRANSCRIPT — step-mode run ${agentRunId} workflow events: ` +
          JSON.stringify(events.map((e) => `${String(e.seq)}:${e.type}`)),
      );
      console.log(
        `  TRANSCRIPT — step-mode run ${agentRunId} child run ids: ` +
          JSON.stringify(childRunIds),
      );
      const perOccurrence = childRunIds.filter((id) => /__\d+$/.test(id));
      if (perOccurrence.length > 0) {
        throw new Error(
          `a step-mode folded run started per-occurrence child runs ` +
            `${JSON.stringify(perOccurrence)}; the folded shape is one ` +
            `unbounded step and must not fan out per message`,
        );
      }
    },
  );

  // ---- proof 2b: the section shape's true per-occurrence child run ---
  //
  // Also CL-6329's first live validation: `mode: "section"` has existed
  // as a config argument since the agent-runtime cutover, but nothing had
  // ever deployed or run one. Here one is deployed for real — rendered
  // into its own source package, pushed as a workflow-kind asset,
  // deployed by source-ref, and driven with real mail — and every message
  // becomes an `onTrigger` occurrence with its own child run id and its
  // own durable event log, which is the artefact the milestone's
  // `RunStarted` assertion was always about.
  const SECTION_ASSET_NAME = "cl6324-section";
  const SECTION_SOURCE_ID = "cl6324-section-source";
  const SECTION_TURN_TIMEOUT_MS = 180_000;
  const sectionAddress = `${SECTION_ASSET_NAME}@${tenant.tenantDomain}`;

  const sectionDeploymentId = await timed(
    "proof 2b: section-mode deploy (push + probe + freeze + deploy)",
    () =>
      hop(
        "PROOF 2b — a section-mode agent deploys from its own rendered source",
        async () => {
          const created = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/assets`,
            {
              kind: "workflow",
              name: SECTION_ASSET_NAME,
              displayName: "CL-6324 section-mode proof",
            },
            user.cookies,
          );
          expectStatus("create the section-mode workflow asset", created, 201);
          const assetId = stringField(
            created.data,
            "id",
            "section-mode asset response",
          );

          const minted = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/git-tokens`,
            {
              name: `cl6324-section-push-${crypto.randomUUID().slice(0, 8)}`,
              resource: "asset:*",
              refPattern: "**",
              actions: ["can_read", "can_push"],
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
            user.cookies,
          );
          expectStatus("mint the section-mode push token", minted, 201);
          const tokenSecret = stringField(
            minted.data,
            "secret",
            "git token response",
          );

          const model = proofModelSource;
          // The same config object every folded launch renders, with the
          // one field that selects the shape flipped to `section`. No
          // tool pins and no credential bindings: this proof is about the
          // occurrence shape, and an empty pin set keeps the deploy off
          // the tool-manifest and MCP-handle surfaces entirely.
          const definition = buildAgentRuntimeWorkflow({
            workflowId: "wf_cl6324_section",
            agentId: "cl6324-section-agent",
            triggerAddress: sectionAddress,
            systemPrompt:
              "You are a terse assistant. Answer in one short sentence.",
            inferencePreferences: [
              { provider: model.provider, model: model.model },
            ],
            toolPackagePins: [],
            credentialBindings: [],
            mode: { kind: "section", turnTimeoutMs: SECTION_TURN_TIMEOUT_MS },
          });

          const pushed = await pushWorkflow({
            remoteUrl: `${hub.baseUrl}/api/tenants/${tenant.tenantId}/assets/workflow/${SECTION_ASSET_NAME}.git`,
            tokenSecret,
            workflowJson: JSON.stringify(definition, null, 2),
            packageName: SECTION_ASSET_NAME,
          });

          const deployed = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/workflows/deployments`,
            {
              source: {
                kind: "asset",
                assetId,
                package: { format: "source", commitSha: pushed.commitSha },
              },
              entry: WORKFLOW_SOURCE_ENTRY,
              sources: [
                {
                  id: SECTION_SOURCE_ID,
                  provider: model.provider,
                  baseURL: model.baseURL,
                  apiKey: model.apiKey,
                  model: model.model,
                },
              ],
              defaultSource: SECTION_SOURCE_ID,
            },
            user.cookies,
          );
          expectStatus("deploy the section-mode workflow", deployed, 201);
          return stringField(
            deployed.data,
            "id",
            "section-mode deployment response",
          );
        },
      ),
  );

  /** Occurrence run ids the section has already produced. */
  const seenOccurrences = new Set<string>();

  const isOccurrenceRunId = (id: string) => /^turn__\d+$/.test(id);

  /**
   * Drives one section occurrence: send real mail, then wait for a
   * NEW child run to record `RunStarted` in its OWN event log. The
   * runtime names an occurrence `<sectionId>__<eventIndex>`
   * (`agentRuntimeTurnRunId`), and the occurrence is discovered rather
   * than assumed so a turn that died in the sidecar kill cannot shift
   * every later index and turn a real pass into a false failure.
   */
  async function driveSectionOccurrence(
    text: string,
    label: string,
  ): Promise<string> {
    const t0 = Date.now();
    // A 409 here means the deployment's address is not routable yet — the
    // state a restart leaves behind while the sidecar's reclaim settles.
    // Retrying the trigger is the same bounded wait a caller would do.
    const triggerDeadline = Date.now() + 60_000;
    for (;;) {
      const triggered = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenant.tenantId}/workflows/${sectionDeploymentId}/mail`,
        { content: text },
        user.cookies,
      );
      if (triggered.status === 202) break;
      if (triggered.status !== 409 || Date.now() > triggerDeadline) {
        expectStatus(`${label}: trigger the section`, triggered, 202);
      }
      await Bun.sleep(2000);
    }

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `${label}: the sidecar exited while the section ran; output:\n${sidecar.output()}`,
        );
      }
      const runIds = await listDeploymentRunIds(sectionDeploymentId);
      for (const turnRunId of runIds) {
        if (!isOccurrenceRunId(turnRunId)) continue;
        if (seenOccurrences.has(turnRunId)) continue;
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenant.tenantId}/workflows/${sectionDeploymentId}/runs/${turnRunId}/events`,
          undefined,
          user.cookies,
        );
        if (res.status !== 200) continue;
        const events = arrayField(
          res.data,
          "events",
          `${label}: section occurrence events`,
        ) as { seq: number; type: string }[];
        if (!events.some((e) => e.type === "RunStarted")) continue;
        seenOccurrences.add(turnRunId);
        timings.push({ label: `${label}: RunStarted`, ms: Date.now() - t0 });
        console.log(`  TRANSCRIPT — >>> (section) ${text}`);
        console.log(
          `  TRANSCRIPT — section occurrence ${turnRunId} events: ` +
            JSON.stringify(events.map((e) => `${String(e.seq)}:${e.type}`)),
        );
        return turnRunId;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${label}: no new section occurrence recorded RunStarted; ` +
            `run ids present: ${JSON.stringify(runIds)}\n` +
            `sidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
  }

  const firstOccurrence = await timed(
    "proof 2b: first section occurrence to RunStarted",
    () =>
      hop(
        "PROOF 2b — every message is an onTrigger occurrence with its own child run",
        () =>
          driveSectionOccurrence(
            "In one short sentence, what can you help me with?",
            "proof 2b",
          ),
      ),
  );

  await hop(
    "PROOF 2b — the first occurrence is the one the runtime's naming predicts",
    async () => {
      const expected = agentRuntimeTurnRunId(0);
      if (firstOccurrence !== expected) {
        throw new Error(
          `the first section occurrence is ${firstOccurrence}, not the ` +
            `${expected} the section's own id derivation predicts`,
        );
      }
      const parentEvents = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${tenant.tenantId}/workflows/${sectionDeploymentId}/runs/${sectionDeploymentId}/events`,
        undefined,
        user.cookies,
      );
      expectStatus("read the section's parent run log", parentEvents, 200);
      const events = arrayField(
        parentEvents.data,
        "events",
        "section parent events",
      ) as { seq: number; type: string; body?: { childRunId?: unknown } }[];
      console.log(
        `  TRANSCRIPT — section parent run events: ` +
          JSON.stringify(events.map((e) => `${String(e.seq)}:${e.type}`)),
      );
      if (
        !events.some(
          (e) => e.type === "ChildSpawned" && e.body?.childRunId === expected,
        )
      ) {
        throw new Error(
          `the section's parent run log records no ChildSpawned for ` +
            `${expected}: ${JSON.stringify(events)}`,
        );
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

  /**
   * Sends one message and waits for the agent's answer.
   *
   * `resendsAllowed` is the number of times the RETRYABLE undelivered
   * notice ("send it again") may be answered by actually sending it
   * again. It is the product's own instruction to the reader, so
   * honouring it is the honest reading of "the next message is
   * answered" — but only where a wake is genuinely racing (the
   * post-restart send in proof 4). Every other caller passes zero, so a
   * notice there is the failure it looks like. The credential notice is
   * never retried: resending can never fix it.
   */
  async function sendAndAwaitReply(
    text: string,
    label: string,
    resendsAllowed = 0,
  ): Promise<void> {
    const t0 = Date.now();
    let resendsLeft = resendsAllowed;
    for (;;) {
      const sent = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenant.tenantId}/chat/workbenches/${chatId}/messages`,
        { parts: [{ kind: "text", text }] },
        user.cookies,
      );
      expectStatus("send message", sent, 201);
      const reply = await awaitFreshReply(label);
      console.log(`  TRANSCRIPT — >>> ${text}`);
      console.log(`  TRANSCRIPT — <<< ${reply}`);
      const retryable = /didn't get that one/i.test(reply);
      if (retryable && resendsLeft > 0) {
        resendsLeft -= 1;
        console.log(
          `  TRANSCRIPT — retryable notice; resending (${String(resendsLeft)} resend(s) left)`,
        );
        continue;
      }
      // Both undelivered notices are agent-authored room messages from
      // the agent's own address, so they look exactly like a reply to
      // the reader above. Neither is a turn.
      if (
        /^\s*$/.test(reply) ||
        retryable ||
        /can't reach a model right now/i.test(reply)
      ) {
        throw new Error(
          `${label}: the agent answered with the undelivered notice, not a ` +
            `real turn: ${JSON.stringify(reply)}\n` +
            `hub output:\n${hub.output()}\n` +
            `sidecar output:\n${sidecar.output()}`,
        );
      }
      timings.push({ label: `${label}: first reply`, ms: Date.now() - t0 });
      return;
    }
  }

  /** Waits for the next agent-authored message this proof has not seen. */
  async function awaitFreshReply(label: string): Promise<string> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      await autoApproveAll();
      const fresh = (await listAgentMessages()).filter(
        (m) => !seenIds.has(m.id),
      );
      if (fresh.length > 0) {
        for (const m of fresh) seenIds.add(m.id);
        return fresh.map((m) => m.text).join(" ");
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

  // The step shape's per-message bracket, asserted where a real turn has
  // definitely happened. `@corbits/insights`' latency tracker opens its
  // row on `message.run.started` and commits it on `message.run.ended`,
  // so a committed sample IS the agent event reaching the hub — durably,
  // over HTTP — which is the honest step-mode analogue of the section
  // shape's `RunStarted`.
  await hop(
    "PROOF 2 (step mode) — the turn's message.run.started/ended bracket is durably recorded",
    async () => {
      // The latency summary is grant-gated and the seed's grant set does
      // not cover it; planting it here keeps this a real read of the real
      // route rather than a skipped check.
      await plantGrant("insights:*", "read");

      const deadline = Date.now() + 60_000;
      for (;;) {
        const brackets = await completedTurnBrackets();
        if (brackets > 0) {
          console.log(
            `  TRANSCRIPT — completed per-message brackets: ${String(brackets)}`,
          );
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(
            "a real reply landed but insights recorded zero turn-latency " +
              "samples, so no message.run.started/ended pair reached the hub",
          );
        }
        await Bun.sleep(2000);
      }
    },
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
            text: MID_TURN_PROMPT,
          },
        ],
      },
      user.cookies,
    );
    expectStatus("send the mid-turn message", sent, 201);
    // The section deployment takes the same kill mid-occurrence, so the
    // restart has to prove `onBodyFailure: "continue"` too: a section
    // that retired on the dead body would never answer again.
    const sectionSent = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenant.tenantId}/workflows/${sectionDeploymentId}/mail`,
      { content: MID_TURN_PROMPT },
      user.cookies,
    );
    expectStatus("send the mid-turn section message", sectionSent, 202);
    // Long enough that the turn is genuinely in flight — the child has
    // the mail and inference is running — but well short of a reply.
    await Bun.sleep(MID_TURN_KILL_DELAY_MS);
    // "Mid-turn" is asserted, not assumed: the prompt above cannot be
    // answered in the kill window on any model, so an answer already
    // sitting in the room would mean the kill landed BETWEEN turns and
    // the proof would be testing the easy case.
    const answeredEarly = (await listAgentMessages()).filter(
      (m) => !seenIds.has(m.id),
    );
    if (answeredEarly.length > 0) {
      throw new Error(
        `the mid-turn kill was not mid-turn: the agent already answered ` +
          `within ${String(MID_TURN_KILL_DELAY_MS)}ms — ` +
          `${JSON.stringify(answeredEarly.map((m) => m.text))}`,
      );
    }
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
          // The room surviving is a hub-only read and says nothing about
          // the execution plane. The run's own health does: `liveness`
          // is "ok" exactly when the sidecar has re-announced the
          // address, which is what boot restore replaying the pin
          // produces. Sending before that is sending into a window the
          // product itself answers with "send it again".
          const health = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/workflows/runs/${agentRunId}/health`,
            undefined,
            user.cookies,
          );
          const liveness = (health.data as { liveness?: unknown }).liveness;
          if (res.status === 200 && liveness === "ok") return;
          if (Date.now() > deadline) {
            throw new Error(
              `the room or its run did not come back after the restart ` +
                `(messages ${String(res.status)}, liveness ${JSON.stringify(liveness)})\n` +
                `sidecar output:\n${sidecar.output()}`,
            );
          }
          await Bun.sleep(1000);
        }
      },
    ),
  );

  // Same rule for the section: the occurrence that died in the kill may
  // already have committed its `RunStarted`, so it is not evidence that
  // the section still answers. Only an occurrence started AFTER the
  // restore counts.
  for (const id of await listDeploymentRunIds(sectionDeploymentId)) {
    if (isOccurrenceRunId(id)) seenOccurrences.add(id);
  }

  // The section deployment rode the same kill. Boot restore replays its
  // pin from the sidecar data dir exactly as it does the folded run's,
  // and `onBodyFailure: "continue"` is what keeps the section subscribed
  // when the killed occurrence died mid-body: a section that retired on
  // that failure would never produce a second occurrence at all.
  //
  // Asserted BEFORE the step shape's half deliberately: the two shapes
  // answer this question differently, and the section's answer must be
  // on the record whatever the step shape does.
  await timed("proof 4: section occurrence after the restart", () =>
    hop(
      "PROOF 4 — the section survives the restart and runs its next occurrence",
      async () => {
        const occurrence = await driveSectionOccurrence(
          "Are you still there? One sentence.",
          "proof 4 (section)",
        );
        console.log(
          `  TRANSCRIPT — post-restart section occurrence: ${occurrence}`,
        );
      },
    ),
  );

  // Whatever the killed turn produced is not the proof that the agent
  // still works — that is the NEXT message's job. But it must not have
  // produced NOTHING: a turn that died with the sidecar has to reach
  // the reader as a partial answer or as the product's own visible
  // notice ("I didn't get that one — send it again"), never as a
  // message that was accepted and then silently swallowed.
  await hop(
    "PROOF 4 — the turn the kill interrupted surfaces visibly",
    async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const fresh = (await listAgentMessages()).filter(
          (m) => !seenIds.has(m.id),
        );
        if (fresh.length > 0) {
          console.log(
            `  TRANSCRIPT — the interrupted turn surfaced as: ` +
              JSON.stringify(fresh.map((m) => m.text)),
          );
          for (const m of fresh) seenIds.add(m.id);
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(
            "the turn the sidecar kill interrupted left NOTHING in the " +
              "room: no partial answer and no undelivered notice, so the " +
              "reader's message was accepted and silently dropped",
          );
        }
        await Bun.sleep(2000);
      }
    },
  );
  await hop("PROOF 4 — the next message is answered after the restart", () =>
    sendAndAwaitReply("Are you still there? One sentence.", "proof 4", 2),
  );

  // The audit trail is the whole reason a relaunch mints a fresh run
  // instead of reclaiming the dead one's address: the run that died
  // mid-turn keeps its own durable log, under its own address, readable
  // through the ordinary run routes — after the run that replaced it is
  // already answering (the hop above).
  await hop("PROOF 4 — the replaced run's log is still readable", async () => {
    const events = await readRunEvents();
    if (events.length === 0) {
      throw new Error(
        `the replaced run ${agentRunId}'s durable event log is unreadable ` +
          `after its replacement went live: the relaunch reclaimed the ` +
          `audit trail it exists to preserve`,
      );
    }
    console.log(
      `  TRANSCRIPT — replaced run ${agentRunId} still readable: ` +
        `${String(events.length)} events, last ${events.at(-1)?.type ?? "?"}`,
    );
  });

  console.log("\n=== TIMINGS ===");
  for (const t of timings) {
    console.log(`  ${t.label}: ${(t.ms / 1000).toFixed(1)}s`);
  }
  console.log("\nAll four proofs passed.");
}

await main();
process.exit(0);
