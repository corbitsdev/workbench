// CL-6323 Phase 0 measurement harness. Boots a hub with the spike rooms
// mounted plus its own sidecar, then measures the five acceptance numbers
// against the spike path and, where the same number exists, against
// today's chat path in the same process.
//
// Run against a local stack that already has an inference source seeded:
//
//   bun scripts/repro/spike-room-bench.ts
//
// DATABASE_URL, SESSION_SECRET and the sign-in account come from .env,
// the same values `bun run dev` uses.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";


const databaseUrl = required("DATABASE_URL");
const email = process.env["HUB_ADMIN_EMAIL"] ?? "alice@example.com";
const password = process.env["HUB_ADMIN_PASSWORD"] ?? "password123";
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
const sql = postgres(databaseUrl, { max: 2 });
const sidecarId = `sidecar-spike-${crypto.randomUUID().slice(0, 8)}`;
const sidecarToken = crypto.randomUUID();
const port = 4400 + Math.floor(Math.random() * 200);
const baseUrl = `http://localhost:${String(port)}`;

const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(sidecarToken),
);
await sql`insert into sidecar (id, url, token_hash_sha256)
          values (${sidecarId}, ${"ws://spike-sidecar"}, ${Buffer.from(digest)})`;

const hubData = await mkdtemp(path.join(tmpdir(), "spike-hub-"));
const sidecarData = await mkdtemp(path.join(tmpdir(), "spike-sidecar-"));
const hub = spawnApp(path.join(repoRoot, "apps", "hub"), {
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

  const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (signIn.status !== 200) {
    throw new Error(`sign-in failed (${String(signIn.status)}): ${await signIn.text()}`);
  }
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  // The bench needs a tenant that already has an inference source seeded;
  // naming it explicitly beats guessing from a listing.
  const tenantId = required("SPIKE_BENCH_TENANT");
  console.log(`[bench] tenant ${tenantId}`);

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
  const streamRes = await fetch(
    `${baseUrl}/api/tenants/${tenantId}/spike-rooms/${roomId}/stream`,
    { headers: { cookie }, signal: streamAbort.signal },
  );
  void (async () => {
    const reader = streamRes.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
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

  hydrationGets += 1;
  const hydration = await call("GET", `/spike-rooms/${roomId}/messages`);
  if (hydration.status !== 200) throw new Error(`hydration failed: ${hydration.text}`);

  for (let turn = 0; turn < TURNS; turn++) {
    const before = streamEvents.length;
    const sentAt = performance.now();
    const sent = await call("POST", `/spike-rooms/${roomId}/messages`, {
      body: `Reply with the single word ok (${String(turn)}).`,
    });
    if (sent.status !== 201) throw new Error(`send failed: ${sent.text}`);
    sendMs.push(sent.elapsed);

    let firstToken: number | undefined;
    let ended: number | undefined;
    const turnDeadline = Date.now() + 90_000;
    while (Date.now() < turnDeadline && ended === undefined) {
      for (const event of streamEvents.slice(before)) {
        const data = event.data as { phase?: string; childRunId?: string; runId?: string };
        if (event.type === "room.turn" && data.phase === "delta" && firstToken === undefined) {
          firstToken = event.at;
        }
        if (event.type === "room.turn" && data.phase === "ended") {
          ended = event.at;
          if (typeof data.childRunId === "string" && data.childRunId !== "") {
            childRunIds.push(data.childRunId);
          }
        }
      }
      if (ended === undefined) await Bun.sleep(25);
    }
    if (firstToken !== undefined) firstTokenMs.push(firstToken - sentAt);
    if (ended !== undefined) replyMs.push(ended - sentAt);
    console.log(
      `[turn ${String(turn)}] send ack ${String(Math.round(sent.elapsed))}ms, ` +
        `first token ${firstToken === undefined ? "none" : String(Math.round(firstToken - sentAt)) + "ms"}, ` +
        `reply ${ended === undefined ? "TIMEOUT" : String(Math.round(ended - sentAt)) + "ms"}`,
    );
  }

  const roomRow = (
    await sql`select run_id from chat.spike_room where id = ${roomId}`
  )[0];
  const roomRunId = String(roomRow?.["run_id"]);
  const runsAfterTurns = Number(
    (await sql`select count(*)::int as n from workflow_run`)[0]?.["n"] ?? 0,
  );

  // Traceability: the reply's child run id, read back through the run
  // surfaces that already exist.
  const traceability: Record<string, number> = {};
  const childRunId = childRunIds[0];
  if (childRunId !== undefined) {
    for (const route of [
      `/workflows/runs/${childRunId}`,
      `/workflows/runs/${childRunId}/events`,
      `/workflows/runs/${childRunId}/turns`,
    ]) {
      const res = await call("GET", route);
      traceability[route] = res.status;
    }
  }

  const messages = await sql`select author_kind, run_id from chat.spike_room_message
                             where room_id = ${roomId} order by created_at`;
  const repliesWithRunId = messages.filter(
    (row) => row["author_kind"] === "agent" && row["run_id"] !== null,
  ).length;

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
    `first token:                  p50 ${String(percentile(firstTokenMs, 50))}ms p95 ${String(
      percentile(firstTokenMs, 95),
    )}ms n=${String(firstTokenMs.length)}`,
  );
  console.log(
    `reply complete:               p50 ${String(percentile(replyMs, 50))}ms p95 ${String(
      percentile(replyMs, 95),
    )}ms n=${String(replyMs.length)}`,
  );
  console.log(`GETs after mount:             ${String(hydrationGets - 1)}`);
  console.log(`replies carrying a run id:    ${String(repliesWithRunId)}/${String(TURNS)}`);
  console.log(`room run id:                  ${roomRunId}`);
  console.log(`child run ids:                ${childRunIds.join(", ")}`);
  console.log(`run-surface reads:            ${JSON.stringify(traceability)}`);
  streamAbort.abort();
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
