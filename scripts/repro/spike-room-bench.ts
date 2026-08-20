// CL-6323 Phase 0 measurement harness. Boots a hub with the spike rooms
// mounted plus its own sidecar, then measures the five acceptance numbers
// against the spike path and, where the same number exists, against
// today's chat path in the same process.
//
// Run it against a local Ollama, which is all the inference it needs:
//
//   bun scripts/repro/spike-room-bench.ts
//
// The bench signs up its own account and connects that Ollama through
// the real onboarding path, so the numbers never depend on which
// credentials a given developer's database happens to hold — and no key
// material is read from anywhere but the environment the hub itself runs
// under. DATABASE_URL comes from .env, the same value `bun run dev` uses.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import { createHubAPI } from "../../packages/hub-client/src/index.ts";
import { OLLAMA_PLACEHOLDER_SECRET } from "../../packages/hub-client/src/credential-test.ts";
import { testAndPersistCredential } from "../../packages/onboarding/src/complete-credential.ts";

const databaseUrl = required("DATABASE_URL");
const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const TURNS = Number(process.env["SPIKE_BENCH_TURNS"] ?? "5");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set (bun loads .env from the repo root)`);
  }
  return value;
}

type Spawned = { stop(): Promise<void>; output(): string; exited(): boolean };

function spawnApp(dir: string, env: Record<string, string>): Spawned {
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let captured = "";
  let done = false;
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) captured += decoder.decode(chunk, { stream: true });
  };
  void capture(proc.stdout);
  void capture(proc.stderr);
  void proc.exited.then(() => {
    done = true;
  });
  return {
    output: () => captured,
    exited: () => done,
    stop: async () => {
      if (done) return;
      proc.kill();
      await proc.exited;
    },
  };
}

/** The catalog model row for `canonicalName`, creating it if it is new. */
async function ensureCatalogModel(
  tenantId: string,
  cookies: string[],
  canonicalName: string,
): Promise<string> {
  const created = await hubApi(
    "POST",
    `/api/tenants/${tenantId}/catalog/models`,
    { canonicalName },
    cookies,
  );
  if (created.status === 201) return (created.data as { id: string }).id;
  if (created.status !== 409) {
    throw new Error(
      `catalog model ${canonicalName} rejected (${String(created.status)})`,
    );
  }
  const listed = await hubApi(
    "GET",
    `/api/tenants/${tenantId}/catalog/models`,
    undefined,
    cookies,
  );
  const existing = (
    listed.data as { data: { id: string; canonicalName: string }[] }
  ).data.find((row) => row.canonicalName === canonicalName);
  if (existing === undefined) {
    throw new Error(`catalog model ${canonicalName} conflicts but is not listable`);
  }
  return existing.id;
}

/** A chat-capable model this machine's Ollama has actually pulled. */
async function pickLocalOllamaModel(): Promise<string> {
  const res = await fetch(`${ollamaBaseUrl}/api/tags`);
  if (!res.ok) {
    throw new Error(
      `no Ollama at ${ollamaBaseUrl} (${String(res.status)}); start one or set OLLAMA_BASE_URL`,
    );
  }
  const tags = (await res.json()) as {
    models: { name: string; capabilities?: string[] }[];
  };
  const chat = tags.models.find((entry) =>
    (entry.capabilities ?? []).includes("completion"),
  );
  if (chat === undefined) {
    throw new Error(`the Ollama at ${ollamaBaseUrl} serves no chat model`);
  }
  return chat.name;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index] ?? Number.NaN);
}

const repoRoot = path.resolve(import.meta.dir, "..", "..");
// The repo root declares no postgres dependency of its own; resolve the
// hub's copy, exactly as the e2e harness does.
const { default: postgres } = (await import(
  Bun.resolveSync("postgres", path.join(repoRoot, "apps", "hub"))
)) as { default: (url: string, opts?: unknown) => never };
// Its own database, rebuilt per run: the catalog a turn resolves against
// then holds only what this bench seeded, and a developer's own data is
// neither read nor disturbed.
const benchDatabaseUrl = (() => {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname.replace(/^\//, "")}_spike_bench`;
  return url.toString();
})();
await resetSchema(benchDatabaseUrl);
await setupDatabase(benchDatabaseUrl);
const sql = postgres(benchDatabaseUrl, { max: 2 });
const sidecarId = `sidecar-spike-${crypto.randomUUID().slice(0, 8)}`;
const sidecarToken = crypto.randomUUID();
const port = 4400 + Math.floor(Math.random() * 200);
const baseUrl = `http://localhost:${String(port)}`;
const hubApi = createHubAPI(baseUrl);

const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(sidecarToken),
);
await sql`insert into sidecar (id, url, token_hash_sha256)
          values (${sidecarId}, ${"ws://spike-sidecar"}, ${Buffer.from(digest)})`;

const hubData = await mkdtemp(path.join(tmpdir(), "spike-hub-"));
const sidecarData = await mkdtemp(path.join(tmpdir(), "spike-sidecar-"));
const hub = spawnApp(path.join(repoRoot, "apps", "hub"), {
  DATABASE_URL: benchDatabaseUrl,
  PORT: String(port),
  BASE_URL: baseUrl,
  HUB_DATA_DIR: hubData,
  HUB_STATIC_DIR: "public",
  WORKBENCH_SPIKE_ROOMS: "1",
  WORKBENCH_SIGNUP: "open",
  ALLOW_UNVERIFIED_EMAILS: "1",
});
let sidecar: Spawned = { stop: async () => undefined, output: () => "", exited: () => true };
const startSidecar = () => {
  sidecar = spawnApp(path.join(repoRoot, "apps", "sidecar"), {
    SIDECAR_DATA_DIR: sidecarData,
    SIDECAR_ID: sidecarId,
    SIDECAR_TOKEN: sidecarToken,
    HUB_WS_URL: `ws://localhost:${String(port)}/api/sidecars/ws`,
  });
};

async function shutdown(): Promise<void> {
  await sidecar.stop();
  await hub.stop();
  await sql`delete from sidecar where id = ${sidecarId}`;
  await sql.end();
}

try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (hub.exited()) throw new Error(`hub exited:\n${hub.output()}`);
    try {
      if ((await fetch(`${baseUrl}/status`)).status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`hub never answered:\n${hub.output()}`);
    await Bun.sleep(250);
  }
  console.log(`[bench] hub up on ${baseUrl}`);
  startSidecar();
  await Bun.sleep(3000);

  const email = `spike-bench-${crypto.randomUUID()}@example.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Spike Bench", email, password }),
  });
  if (signUp.status !== 200) {
    throw new Error(`sign-up failed (${String(signUp.status)}): ${await signUp.text()}`);
  }
  const setCookies = signUp.headers.getSetCookie().map((c) => c.split(";")[0]);
  const cookie = setCookies.join("; ");
  const userId = (JSON.parse(await signUp.text()) as { user: { id: string } }).user.id;

  const provision = await hubApi(
    "POST",
    "/api/onboarding/provision",
    { name: "Spike Bench" },
    setCookies,
  );
  if (provision.status !== 200) {
    throw new Error(`provision failed (${String(provision.status)})`);
  }

  // The same connect the onboarding page drives, pointed at a local
  // Ollama: a real credential, sealed under the hub's own key, so a turn
  // resolves a source exactly the way a signed-up person's does.
  const connected = await testAndPersistCredential({
    api: hubApi,
    cookies: setCookies,
    hubUrl: baseUrl,
    userId,
    userEmail: email,
    provider: "ollama",
    apiKey: OLLAMA_PLACEHOLDER_SECRET,
    baseURLOverride: ollamaBaseUrl,
    pushWorkflow: () => {
      throw new Error("the bench never pushes a workflow");
    },
    log: () => undefined,
  });
  if (connected.kind !== "connected") {
    throw new Error(`connecting ollama failed: ${JSON.stringify(connected)}`);
  }
  const tenantId = connected.tenantId;

  // The connect offers every model the local Ollama has pulled at one
  // shared priority, so the tenant default falls to whichever name sorts
  // first — an embedding model on most machines. The bench promotes the
  // one chat model it means to measure to the head of that list.
  const localModel = await pickLocalOllamaModel();
  const modelId = await ensureCatalogModel(tenantId, setCookies, localModel);
  const offerings = await hubApi(
    "GET",
    `/api/tenants/${tenantId}/catalog/offerings`,
    undefined,
    setCookies,
  );
  const chatOffering = (
    offerings.data as { data: { id: string; modelId: string }[] }
  ).data.find((entry) => entry.modelId === modelId);
  if (chatOffering === undefined) {
    throw new Error(`no offering for ${localModel} on the bench tenant`);
  }
  const promoted = await hubApi(
    "PATCH",
    `/api/tenants/${tenantId}/catalog/offerings/${chatOffering.id}`,
    { priority: 0 },
    setCookies,
  );
  if (promoted.status !== 200) {
    throw new Error(`promoting ${localModel} failed (${String(promoted.status)})`);
  }
  console.log(`[bench] tenant ${tenantId} (ollama ${localModel} at ${ollamaBaseUrl})`);

  const call = async (method: string, route: string, body?: unknown) => {
    const started = performance.now();
    const res = await fetch(`${baseUrl}/api/tenants/${tenantId}${route}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const elapsed = performance.now() - started;
    const text = await res.text();
    return { status: res.status, elapsed, text };
  };

  const runsBefore = Number(
    (await sql`select count(*)::int as n from workflow_run`)[0]?.["n"] ?? 0,
  );

  const createdAt = performance.now();
  const created = await call("POST", "/spike-rooms", { name: "Spike room" });
  if (created.status !== 201) throw new Error(`room create failed: ${created.text}`);
  const roomId = (JSON.parse(created.text) as { id: string }).id;
  const openMs = Math.round(performance.now() - createdAt);
  const runsAfterOpen = Number(
    (await sql`select count(*)::int as n from workflow_run`)[0]?.["n"] ?? 0,
  );
  console.log(
    `[1] room open: ${String(openMs)}ms, workflow_run rows added: ${String(
      runsAfterOpen - runsBefore,
    )}`,
  );

  // The stream is the only read after mount; every later assertion about
  // "no refetch" is this counter staying at one hydration GET.
  let hydrationGets = 0;
  const firstTokenMs: number[] = [];
  const replyMs: number[] = [];
  const sendMs: number[] = [];
  const childRunIds: string[] = [];

  const streamAbort = new AbortController();
  const streamEvents: { type: string; at: number; data: unknown }[] = [];
  // The SSE response's headers do not land until the first frame, so the
  // reader is attached without awaiting the fetch.
  void (async () => {
    const streamRes = await fetch(
      `${baseUrl}/api/tenants/${tenantId}/spike-rooms/${roomId}/stream`,
      { headers: { cookie }, signal: streamAbort.signal },
    );
    const reader = streamRes.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader
        .read()
        .catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (type === undefined || data === undefined) continue;
        streamEvents.push({ type, at: performance.now(), data: JSON.parse(data) });
      }
    }
  })();
  await Bun.sleep(500);

  hydrationGets += 1;
  const hydration = await call("GET", `/spike-rooms/${roomId}/messages`);
  if (hydration.status !== 200) throw new Error(`hydration failed: ${hydration.text}`);

  type TurnOutcome = {
    label: string;
    sendAckMs: number;
    firstTokenMs?: number;
    replyMs?: number;
    status: "completed" | "failed" | "unresolved";
    childRunId?: string;
  };

  /** Sends one message and follows its turn on the stream alone. */
  async function runTurn(
    label: string,
    body: string,
    options: { waitMs: number; onFirstToken?: () => Promise<void> } = {
      waitMs: 90_000,
    },
  ): Promise<TurnOutcome> {
    const before = streamEvents.length;
    const sentAt = performance.now();
    const sent = await call("POST", `/spike-rooms/${roomId}/messages`, { body });
    if (sent.status !== 201) throw new Error(`send failed: ${sent.text}`);

    const outcome: TurnOutcome = {
      label,
      sendAckMs: sent.elapsed,
      status: "unresolved",
    };
    let firstTokenHandled = false;
    const deadline = Date.now() + options.waitMs;
    while (Date.now() < deadline && outcome.status === "unresolved") {
      for (const event of streamEvents.slice(before)) {
        if (event.type !== "room.turn") continue;
        const data = event.data as {
          phase?: string;
          childRunId?: string;
          status?: "completed" | "failed";
        };
        if (typeof data.childRunId === "string" && data.childRunId !== "") {
          outcome.childRunId = data.childRunId;
        }
        if (data.phase === "delta" && outcome.firstTokenMs === undefined) {
          outcome.firstTokenMs = event.at - sentAt;
        }
        if (data.phase === "ended") {
          outcome.replyMs = event.at - sentAt;
          outcome.status = data.status ?? "failed";
        }
      }
      if (
        outcome.firstTokenMs !== undefined &&
        !firstTokenHandled &&
        options.onFirstToken !== undefined
      ) {
        firstTokenHandled = true;
        await options.onFirstToken();
      }
      if (outcome.status === "unresolved") await Bun.sleep(25);
    }
    console.log(
      `[${label}] send ack ${String(Math.round(outcome.sendAckMs))}ms, ` +
        `first token ${
          outcome.firstTokenMs === undefined
            ? "none"
            : String(Math.round(outcome.firstTokenMs)) + "ms"
        }, ` +
        `reply ${
          outcome.replyMs === undefined
            ? "none"
            : String(Math.round(outcome.replyMs)) + "ms"
        } (${outcome.status})`,
    );
    return outcome;
  }

  const outcomes: TurnOutcome[] = [];
  for (let turn = 0; turn < TURNS; turn++) {
    const outcome = await runTurn(
      turn === 0 ? "turn 0 (cold)" : `turn ${String(turn)} (warm)`,
      `Reply with the single word ok (${String(turn)}).`,
    );
    outcomes.push(outcome);
    sendMs.push(outcome.sendAckMs);
    if (outcome.firstTokenMs !== undefined) firstTokenMs.push(outcome.firstTokenMs);
    if (outcome.replyMs !== undefined) replyMs.push(outcome.replyMs);
    if (outcome.childRunId !== undefined) childRunIds.push(outcome.childRunId);
  }
  const warmFirstTokens = outcomes
    .slice(1)
    .map((outcome) => outcome.firstTokenMs)
    .filter((value): value is number => value !== undefined);

  // [5] A turn killed under the room: the sidecar — the whole execution
  // plane — is killed while the turn is streaming, then brought back. The
  // room is expected to outlive it, the damage to stop at that turn, and
  // the next message to be answered normally.
  const killed = await runTurn(
    "killed turn",
    "Count slowly from one to fifty, one number per line.",
    {
      waitMs: 60_000,
      onFirstToken: async () => {
        console.log("[5] killing the sidecar mid-turn");
        await sidecar.stop();
      },
    },
  );
  const roomAfterKill = await call("GET", `/spike-rooms/${roomId}/messages`);
  console.log(
    `[5] room after the kill: GET messages ${String(roomAfterKill.status)}, ` +
      `killed turn ${killed.status}`,
  );
  startSidecar();
  await Bun.sleep(15_000);
  console.log("--- sidecar after the restart ---");
  console.log(sidecar.output().split("\n").slice(0, 12).join("\n"));
  const afterKill = await runTurn(
    "turn after the kill",
    "Reply with the single word ok (after the kill).",
    { waitMs: 120_000 },
  );

  const roomRow = (
    await sql`select run_id from chat.spike_room where id = ${roomId}`
  )[0];
  const roomRunId = String(roomRow?.["run_id"]);
  const runsAfterTurns = Number(
    (await sql`select count(*)::int as n from workflow_run`)[0]?.["n"] ?? 0,
  );

  // [6] Traceability: a reply row's run id, read back through the run
  // surfaces that already exist. The reply carries the turn's child run
  // id; the room's own run id is what the run routes are keyed by, so
  // both are read and the child id is looked for inside the log.
  const messages = await sql`select id, author_kind, run_id, body from chat.spike_room_message
                             where room_id = ${roomId} order by created_at`;
  const replies = messages.filter((row) => row["author_kind"] === "agent");
  const repliesWithRunId = replies.filter((row) => row["run_id"] !== null).length;
  const tracedChildRunId =
    replies.map((row) => row["run_id"]).find((value) => value !== null) ?? null;

  const traceability: Record<string, string> = {};
  for (const [label, route] of [
    ["room run", `/workflows/runs/${roomRunId}`],
    ["room run events", `/workflows/runs/${roomRunId}/events`],
    ["room run turns", `/workflows/runs/${roomRunId}/turns`],
    ...(tracedChildRunId !== null
      ? ([
          ["child run", `/workflows/runs/${String(tracedChildRunId)}`],
          ["child run events", `/workflows/runs/${String(tracedChildRunId)}/events`],
        ] as const)
      : []),
  ] as const) {
    const res = await call("GET", route);
    const mentions =
      tracedChildRunId !== null && res.text.includes(String(tracedChildRunId));
    traceability[label] =
      `${String(res.status)}${res.status === 200 && mentions ? " (names the child run)" : ""}`;
    if (label === "room run events" && mentions) {
      const body = JSON.parse(res.text) as { data?: unknown[]; items?: unknown[] };
      const events = body.data ?? body.items ?? [];
      const naming = events.filter((event) =>
        JSON.stringify(event).includes(String(tracedChildRunId)),
      );
      const sample =
        naming[0] !== undefined
          ? JSON.stringify(naming[0])
          : res.text.slice(
              Math.max(0, res.text.indexOf(String(tracedChildRunId)) - 160),
            );
      console.log(
        `[6] ${String(naming.length)} of ${String(events.length)} room-run events name ` +
          `${String(tracedChildRunId)}; around the match: ${sample.slice(0, 300)}`,
      );
    }
  }

  console.log("");
  console.log("=== spike room results ===");
  console.log(`room open (no deploy):        ${String(openMs)}ms`);
  console.log(`workflow_run rows on open:    ${String(runsAfterOpen - runsBefore)}`);
  console.log(`workflow_run rows after turns:${String(runsAfterTurns - runsAfterOpen)}`);
  console.log(
    `send ack (visible):           p50 ${String(percentile(sendMs, 50))}ms p95 ${String(
      percentile(sendMs, 95),
    )}ms n=${String(sendMs.length)}`,
  );
  console.log(
    `first token (warm room):      p50 ${String(percentile(warmFirstTokens, 50))}ms p95 ${String(
      percentile(warmFirstTokens, 95),
    )}ms n=${String(warmFirstTokens.length)} ` +
      `[${warmFirstTokens.map((value) => String(Math.round(value))).join(", ")}]`,
  );
  console.log(
    `first token (cold room):      ${
      outcomes[0]?.firstTokenMs === undefined
        ? "none"
        : String(Math.round(outcomes[0].firstTokenMs)) + "ms"
    }`,
  );
  console.log(
    `reply complete:               p50 ${String(percentile(replyMs, 50))}ms p95 ${String(
      percentile(replyMs, 95),
    )}ms n=${String(replyMs.length)}`,
  );
  console.log(`GETs after mount:             ${String(hydrationGets - 1)}`);
  console.log(
    `killed turn:                  ${killed.status}, room readable after: ${String(
      roomAfterKill.status,
    )}`,
  );
  console.log(
    `turn after the kill:          ${afterKill.status}, first token ${
      afterKill.firstTokenMs === undefined
        ? "none"
        : String(Math.round(afterKill.firstTokenMs)) + "ms"
    }`,
  );
  console.log(
    `replies carrying a run id:    ${String(repliesWithRunId)}/${String(replies.length)}`,
  );
  console.log(`room run id:                  ${roomRunId}`);
  console.log(`child run ids:                ${childRunIds.join(", ")}`);
  console.log(`run-surface reads:            ${JSON.stringify(traceability)}`);
  console.log("--- replies ---");
  for (const reply of replies) {
    console.log(
      `${String(reply["run_id"])}: ${String(reply["body"]).slice(0, 120).replaceAll("\n", " ")}`,
    );
  }
  streamAbort.abort();
  console.log("--- hub log (spike lines) ---");
  console.log(
    hub
      .output()
      .split("\n")
      .filter((line) => line.includes("spike"))
      .slice(-20)
      .join("\n"),
  );
} catch (err) {
  console.error(err);
  console.error("--- hub output (tail) ---");
  console.error(hub.output().split("\n").slice(-60).join("\n"));
  console.error("--- sidecar output (tail) ---");
  console.error(sidecar.output().split("\n").slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  await shutdown();
}
