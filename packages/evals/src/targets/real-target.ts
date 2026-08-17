// The live Myra `Target` (CL-6143): boots a real hub + sidecar against
// a real Postgres, signs up a throwaway user, connects an inference
// credential, deploys the "assistant" workflow, mints a chat with it,
// and plays scripted human turns through the real HTTP API — the same
// boot sequence `scripts/e2e/greeting-delivery.test.ts` proves end to
// end, generalized here into something `runEval`/`runMatrix` can drive
// once per matrix config instead of once per test file.
//
// Two modes, chosen by whether `EVAL_PROVIDER_API_KEY` is set:
//   - live:     a real Anthropic key, so replies are genuine model
//               output and tool calls are genuine tool calls.
//   - plumbing: a stub key (never sent anywhere real — the platform's
//               own inference director folds the provider's 401 into a
//               completed turn carrying a credential-error report, the
//               same fixture `greeting-delivery.test.ts` and
//               `local-rip.test.ts` already rely on), so every turn
//               still gets delivered and recorded with zero real
//               inference spend. `bun run eval` uses this mode to keep
//               CI green with no key configured.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGitWorkflowPusher,
  createHubAPI,
  type ApiCall,
} from "@workbench/hub-client";
import { completeCredentialSetup } from "@workbench/onboarding";
import { OLLAMA_PLACEHOLDER_SECRET } from "@workbench/hub-client";

import { resetSchema, setupDatabase } from "../../../../scripts/db-setup.ts";
import {
  api,
  connectE2eDb,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  provisionSidecar,
  startHub,
  startSidecar,
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "../../../../scripts/e2e/harness.ts";
import type { RunConfig, Target, Turn } from "../types.ts";
import {
  newToolCallsSince,
  readAllToolCalls,
  type SqlClientLike,
} from "./trace.ts";

/** Never sent anywhere for real in plumbing mode — see the module
 * comment. Only used when `EVAL_PROVIDER_API_KEY` is unset. */
const STUB_API_KEY = "corbits-evals-stub-key-not-real";

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

interface ChatMessage {
  readonly id: string;
  readonly sender: { readonly address: string };
  readonly parts: readonly { readonly kind: string; readonly text?: string }[];
}

/** Pure: the first message in `items` that (a) wasn't already in
 * `seenIds`, (b) is authored by `agentAddress`, and (c) carries text —
 * the "did Myra reply yet" check, factored out so it's unit-testable
 * without booting anything. */
export function findNewAgentReply(
  items: readonly ChatMessage[],
  agentAddress: string,
  seenIds: ReadonlySet<string>,
): ChatMessage | undefined {
  return items.find(
    (item) =>
      !seenIds.has(item.id) &&
      item.sender.address === agentAddress &&
      item.parts.some(
        (part) => part.kind === "text" && (part.text ?? "") !== "",
      ),
  );
}

function replyTextOf(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text ?? "")
    .join("");
}

async function pollUntil<T>(
  what: string,
  deadlineMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: timed out after ${String(deadlineMs)}ms`);
    }
    await Bun.sleep(1000);
  }
}

/**
 * Boots one real Myra deployment and returns a `Target` that plays
 * turns against it over the real HTTP API. The caller owns calling
 * `close()` exactly once — every process, port, and DB connection this
 * opens is released there, in reverse order, even if a later step in
 * this function throws partway through boot.
 */
export async function bootMyraTarget(config: RunConfig): Promise<Target> {
  if (
    config.systemPromptOverride !== undefined ||
    config.toolPins !== undefined
  ) {
    // [Gap worth flagging: the live target has no wiring today to push a
    // matrix entry's systemPromptOverride/toolPins into the deployed
    // "assistant" workflow before minting a chat — `ensureSeeded`
    // deploys the tenant's one stored copy of each default workflow, not
    // a per-run variant. Failing loudly here beats silently ignoring the
    // matrix entry's request.]
    throw new Error(
      `bootMyraTarget("${config.name}"): systemPromptOverride/toolPins are not ` +
        "wired to the live target yet — see the comment above this throw",
    );
  }

  const databaseUrl = e2eDatabaseUrl();
  if (databaseUrl === undefined) {
    throw new Error(
      "bootMyraTarget: DATABASE_URL is not set; the live Myra target needs a " +
        "reachable Postgres (see .env.example)",
    );
  }

  const cleanups: (() => Promise<void>)[] = [];
  async function closeAll(): Promise<void> {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  }

  try {
    await resetSchema(databaseUrl);
    const report = await setupDatabase(databaseUrl);
    if (report.action !== "migrated") {
      throw new Error(`db setup: expected "migrated", got "${report.action}"`);
    }

    const runToken = crypto.randomUUID().slice(0, 8);
    const sidecarId = `evals-${config.name}-${runToken}`;
    const sidecarToken = crypto.randomUUID();
    await provisionSidecar(databaseUrl, sidecarId, sidecarToken);

    const hubDataDir = await mkdtemp(path.join(tmpdir(), "evals-hub-data-"));
    const hub: HubHandle = await startHub({
      databaseUrl,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: hubDataDir,
    });
    cleanups.push(() => hub.stop());
    cleanups.push(() => rm(hubDataDir, { recursive: true, force: true }));

    const sidecarDataDir = await mkdtemp(
      path.join(tmpdir(), "evals-sidecar-data-"),
    );
    const sidecar: SpawnedApp = startSidecar({
      hubPort: Number(new URL(hub.baseUrl).port || "80"),
      sidecarId,
      token: sidecarToken,
      dataDir: sidecarDataDir,
    });
    cleanups.push(() => sidecar.stop());
    cleanups.push(() => rm(sidecarDataDir, { recursive: true, force: true }));

    const hubApi: ApiCall = createHubAPI(hub.baseUrl);
    const pushWorkflow = createGitWorkflowPusher();

    const email = `evals-${config.name}-${crypto.randomUUID()}@example.invalid`;
    const password = `pw-${crypto.randomUUID()}`;
    const signUpRes = await api(
      hub.baseUrl,
      "POST",
      "/api/auth/sign-up/email",
      {
        name: `Evals ${config.name}`,
        email,
        password,
      },
    );
    expectStatus(`sign-up for ${config.name}`, signUpRes, 200);
    if (signUpRes.cookies.length === 0) {
      throw new Error(`sign-up for ${config.name} returned no session cookie`);
    }
    const userId = stringField(
      (signUpRes.data as { user: unknown }).user,
      "id",
      `sign-up user field for ${config.name}`,
    );
    const cookies = signUpRes.cookies;

    const provisionRes = await api(
      hub.baseUrl,
      "POST",
      "/api/onboarding/provision",
      { name: `Evals ${config.name}'s Bench` },
      cookies,
    );
    expectStatus(
      `provision personal bench for ${config.name}`,
      provisionRes,
      200,
    );

    // EVAL_PROVIDER=ollama + OLLAMA_BASE_URL runs against a local Ollama
    // (no key: the fixed placeholder secret); otherwise an Anthropic key.
    const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"];
    const useOllama =
      process.env["EVAL_PROVIDER"] === "ollama" && ollamaBaseUrl !== undefined;
    const provider = useOllama ? ("ollama" as const) : ("anthropic" as const);
    const apiKey = useOllama
      ? OLLAMA_PLACEHOLDER_SECRET
      : (process.env["EVAL_PROVIDER_API_KEY"] ?? STUB_API_KEY);

    const seeded = await pollUntil(
      "connecting the inference credential and deploying default workflows",
      60_000,
      async () => {
        try {
          const outcome = await completeCredentialSetup({
            api: hubApi,
            cookies,
            hubUrl: hub.baseUrl,
            userId,
            userEmail: email,
            provider,
            apiKey,
            pushWorkflow,
            log: () => undefined,
            ...(useOllama && ollamaBaseUrl !== undefined
              ? { baseURLOverride: ollamaBaseUrl }
              : {}),
          });
          if (outcome.kind !== "seeded") {
            throw new Error(
              `expected "seeded", got: ${JSON.stringify(outcome)}`,
            );
          }
          return outcome;
        } catch (cause) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited while seeding; output:\n${sidecar.output()}`,
              { cause },
            );
          }
          if (process.env["EVALS_DEBUG"] === "1") {
            console.error("seeding attempt failed, retrying:", cause);
          }
          return undefined;
        }
      },
    );

    const assistantDefinitionId = await pollUntil(
      '"assistant" becoming invitable',
      60_000,
      async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${seeded.tenantId}/chat/invitable-definitions`,
          undefined,
          cookies,
        );
        if (res.status !== 200) return undefined;
        const items = arrayField(
          res.data,
          "items",
          "list invitable definitions",
        ) as {
          id: string;
          name: string;
        }[];
        return items.find((item) => item.name === "assistant")?.id;
      },
    );

    const { chatId, agentAddress } = await pollUntil(
      "POST /channels kind=chat definitionId=assistant",
      60_000,
      async () => {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before chat creation; output:\n${sidecar.output()}`,
          );
        }
        const res: ApiResult = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${seeded.tenantId}/chat/channels`,
          { kind: "chat", definitionId: assistantDefinitionId },
          cookies,
        );
        if (res.status === 500) return undefined;
        expectStatus("create chat", res, 201);
        const id = stringField(res.data, "id", "create chat");
        const participants = arrayField(
          res.data,
          "participants",
          "create chat",
        ) as {
          address: string;
          handle: string;
        }[];
        const agent = participants.find(
          (participant) => participant.handle === "myra",
        );
        if (agent === undefined) {
          throw new Error(
            `chat has no "myra" agent participant: ${JSON.stringify(participants)}`,
          );
        }
        return { chatId: id, agentAddress: agent.address };
      },
    );

    const sql = await connectE2eDb(databaseUrl);
    cleanups.push(() => sql.end());
    const sqlClient: SqlClientLike = sql;

    const seenMessageIds = new Set<string>();
    let toolCallsConsumed = 0;

    function bootFailureOutput(): string {
      return (
        `hub output (tail):\n${hub.output().slice(-60_000)}\n` +
        `sidecar output (tail):\n${sidecar.output().slice(-6_000)}`
      );
    }

    // `POST /channels` fires `dispatchGreetingKickoff` fire-and-forget
    // (see `packages/chat/src/routes.ts`) right after the chat mints —
    // the unprompted-greeting turn `greeting-delivery.test.ts` proves
    // lands with zero user messages sent. That test waits for the
    // greeting's own agent-authored message to land *before* sending
    // its first human turn; this target must do the same, or the first
    // scripted turn's human message and mail fan-out race the still
    // in-flight greeting turn's own record-mail to the channel host,
    // which is what the "run 'run_<channelId>' is terminal" rejection
    // traces back to. The greeting's message id (and its tool calls) are
    // folded in as already-seen so `sendTurn`'s own reply/tool-call
    // bookkeeping for turn 1 starts clean.
    const greeting = await pollUntil(
      "Myra's unprompted greeting landing with zero user messages sent",
      300_000,
      async () => {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited waiting for the greeting; ${bootFailureOutput()}`,
          );
        }
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${seeded.tenantId}/chat/channels/${chatId}/messages`,
          undefined,
          cookies,
        );
        expectStatus("list messages while waiting for the greeting", res, 200);
        const items = arrayField(
          res.data,
          "items",
          "list messages while waiting for the greeting",
        ) as ChatMessage[];
        return findNewAgentReply(items, agentAddress, seenMessageIds);
      },
    ).catch((cause) => {
      throw new Error(
        `no unprompted greeting within 300s; ${bootFailureOutput()}`,
        { cause },
      );
    });
    seenMessageIds.add(greeting.id);
    // See the settle-window comment in `sendTurn` below — the greeting's
    // own record-mail into the channel host needs the same room to land
    // before the first scripted turn posts.
    await Bun.sleep(3_000);
    const greetingToolCalls = await readAllToolCalls(
      sqlClient,
      seeded.tenantId,
      chatId,
    );
    toolCallsConsumed = newToolCallsSince(
      greetingToolCalls,
      toolCallsConsumed,
    ).consumed;

    async function sendTurn(human: string): Promise<Turn> {
      const postRes = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${seeded.tenantId}/chat/channels/${chatId}/messages`,
        { parts: [{ kind: "text", text: human }] },
        cookies,
      );
      expectStatus(`post message "${human}"`, postRes, 201);

      const beforeRes = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${seeded.tenantId}/chat/channels/${chatId}/messages`,
        undefined,
        cookies,
      );
      expectStatus("list messages before reply", beforeRes, 200);
      for (const item of arrayField(
        beforeRes.data,
        "items",
        "list messages before reply",
      ) as ChatMessage[]) {
        seenMessageIds.add(item.id);
      }

      // A 27B local Ollama model, with tools, can take well over two
      // minutes for one turn — 300s gives it room without masking a
      // genuine hang (the sidecar-exited check above still fails fast
      // on that).
      let lastItems: ChatMessage[] = [];
      const reply = await pollUntil(
        `Myra's reply to "${human}"`,
        300_000,
        async () => {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited waiting for a reply; ${bootFailureOutput()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${seeded.tenantId}/chat/channels/${chatId}/messages`,
            undefined,
            cookies,
          );
          expectStatus("list messages", res, 200);
          const items = arrayField(
            res.data,
            "items",
            "list messages",
          ) as ChatMessage[];
          lastItems = items;
          return findNewAgentReply(items, agentAddress, seenMessageIds);
        },
      ).catch((cause) => {
        throw new Error(
          `no reply within 300s; last-seen messages: ${JSON.stringify(lastItems)}\n` +
            bootFailureOutput(),
          { cause },
        );
      });
      seenMessageIds.add(reply.id);

      // A landed reply still has its own record-mail settling into the
      // channel host's shared timeline (`sendChannelMessage`'s "for the
      // record" delivery) — posting the next turn's human message before
      // that settles races the host's write with this turn's, which is
      // what a `path_violation` pack rejection and a subsequent
      // "workflow run ... is terminal" (see the module comment) traces
      // back to. A short settle window here is the same fix
      // `greeting-delivery.test.ts` reaches for via `E2E_TURN2_DELAY_MS`.
      await Bun.sleep(3_000);

      const allToolCalls = await readAllToolCalls(
        sqlClient,
        seeded.tenantId,
        chatId,
      );
      const { newCalls, consumed } = newToolCallsSince(
        allToolCalls,
        toolCallsConsumed,
      );
      toolCallsConsumed = consumed;

      return { human, replyText: replyTextOf(reply), toolCalls: newCalls };
    }

    return {
      configName: config.name,
      sendTurn,
      close: closeAll,
    };
  } catch (cause) {
    await closeAll();
    throw cause;
  }
}
