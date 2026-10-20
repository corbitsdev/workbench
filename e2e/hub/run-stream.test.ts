// DB-gated. A run's live progress and its saved steps reach the browser:
// the stream route forwards a run's inference events as browser-safe frames,
// and the inference-turns route serves the reasoning and tool traces the
// event collector saved. The router is a stub whose subscribers the test
// drives directly, in the same order the hub orchestrator does: collector
// first, then subscribers.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { createDB, schema, type DB } from "@intx/db";
import { createRunStreamRoutes, type TenantEnv } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import { createEventCollectorRegistry, type EventCollectorRegistry } from "@intx/hub-sessions";
import type { InferenceEvent } from "@intx/types/runtime";

import { e2eDatabaseUrl } from "../lib/database-url";
import { dbGate } from "../lib/db-gate";

function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

type Frame = { readonly type: string } & Record<string, unknown>;

const partial = { text: "" };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 };
const source = { sourceId: "src_test", provider: "test", model: "m" };
const SIGNATURE = "sig-must-not-leak";
const REDACTED = "redacted-must-not-leak";

describeIfDb("run stream", () => {
  let db: DB;
  let registry: EventCollectorRegistry;
  let app: Hono<TenantEnv>;
  const subscribers = new Map<string, Set<(event: unknown) => void>>();

  const tenantId = generateId("tenant");
  const userPrincipalId = generateId("principal");
  const runPrincipalId = generateId("principal");
  const definitionId = generateId("workflowDefinition");
  const runId = generateId("workflowRun");
  const sessionId = generateId("session");
  const domain = `run-stream-${tenantId}.localhost`;
  const address = `${runId}@${domain}`;
  let seq = 0;

  // Mirrors the orchestrator: the collector sees an event before subscribers do.
  function emit(event: InferenceEvent): void {
    registry.dispatch(address, event);
    for (const callback of subscribers.get(address) ?? []) callback(event);
  }
  const next = () => ++seq;

  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    db = createDB(dbConfigFromUrl(databaseUrl));
    await db.db.insert(schema.tenant).values({
      id: tenantId,
      name: "Run Stream Test Tenant",
      slug: `run-stream-${tenantId.replaceAll("_", "-")}`,
      domain,
      parentId: null,
      config: null,
    });
    await db.db.insert(schema.principal).values([
      { id: userPrincipalId, tenantId, kind: "user", refId: "usr_test", status: "active" },
      { id: runPrincipalId, tenantId, kind: "workflow", refId: runId, status: "active" },
    ]);
    await db.db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId,
      creatorPrincipalId: userPrincipalId,
      assetId: null,
      name: "run-stream-test-definition",
    });
    await db.db.insert(schema.workflowRun).values({
      id: runId,
      definitionId,
      anchorRunId: runId,
      tenantId,
      principalId: runPrincipalId,
      address,
      status: "running",
    });
    const now = new Date();
    await db.db.insert(schema.agentSession).values({
      id: sessionId,
      tenantId,
      agentId: definitionId,
      principalId: runPrincipalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    registry = createEventCollectorRegistry({
      db: db.db,
      onTurnFinalized(agentAddress, turn) {
        for (const callback of subscribers.get(agentAddress) ?? []) {
          callback({ type: "turn.committed", data: turn });
        }
      },
    });
    registry.create(address, tenantId, sessionId, runId);

    const tenantRow = await db.db.query.tenant.findFirst({
      where: eq(schema.tenant.id, tenantId),
    });
    const principalRow = await db.db.query.principal.findFirst({
      where: eq(schema.principal.id, userPrincipalId),
    });
    if (tenantRow === undefined || principalRow === undefined) throw new Error("seed failed");

    app = new Hono<TenantEnv>();
    app.use(async (c, nextHandler) => {
      c.set("tenant", tenantRow);
      c.set("principal", principalRow);
      await nextHandler();
    });
    app.route(
      "/runs",
      createRunStreamRoutes({
        db: db.db,
        sidecarRouter: {
          subscribeAgent(agentAddress, callback) {
            const set = subscribers.get(agentAddress) ?? new Set();
            set.add(callback);
            subscribers.set(agentAddress, set);
            return () => set.delete(callback);
          },
        },
        eventCollectors: registry,
        requireGrant: () => async (_c, nextHandler) => {
          await nextHandler();
        },
      }),
    );
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await db.db.delete(schema.inferenceTurn).where(eq(schema.inferenceTurn.tenantId, tenantId));
    await db.db.delete(schema.agentSession).where(eq(schema.agentSession.id, sessionId));
    await db.db.delete(schema.workflowRun).where(eq(schema.workflowRun.id, runId));
    await db.db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, definitionId));
    await db.db
      .delete(schema.principal)
      .where(inArray(schema.principal.id, [runPrincipalId, userPrincipalId]));
    await db.db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
  });

  async function waitFor(done: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100 && !(await done()); i++) await Bun.sleep(20);
  }

  // Reads SSE frames off a stream response until `until` matches one or the
  // deadline passes; returns every frame seen.
  function openStream(response: Response) {
    const body = response.body;
    if (body === null) throw new Error("stream response has no body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: Frame[] = [];
    async function readUntil(until: (frame: Frame) => boolean): Promise<Frame[]> {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const hit = frames.find(until);
        if (hit !== undefined) return frames;
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(deadline - Date.now()).then(() => undefined),
        ]);
        if (chunk === undefined || chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === "run" && data !== undefined) frames.push(JSON.parse(data) as Frame);
          boundary = buffer.indexOf("\n\n");
        }
      }
      return frames;
    }
    return { frames, readUntil, cancel: () => reader.cancel() };
  }

  const stream = () => app.fetch(new Request(`http://localhost/runs/${runId}/stream`));

  test("opens with the run's status and the step's in-progress text", async () => {
    emit({ type: "inference.start", seq: next(), data: { model: "m" } });
    emit({ type: "inference.text.delta", seq: next(), data: { token: "Hel", partial } });
    await waitFor(() => registry.getAccumulatedText(address) === "Hel");

    const response = await stream();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const live = openStream(response);
    const frames = await live.readUntil((frame) => frame.type === "snapshot");
    await live.cancel();

    expect(frames[0]).toEqual({ type: "snapshot", status: "busy", text: "Hel" });
  });

  test("streams reasoning and tool traces without signatures or redacted thinking", async () => {
    const live = openStream(await stream());
    await live.readUntil((frame) => frame.type === "snapshot");

    emit({ type: "inference.start", seq: next(), data: { model: "m" } });
    emit({ type: "inference.thinking.delta", seq: next(), data: { token: "Plan ", partial } });
    emit({ type: "inference.thinking.delta", seq: next(), data: { token: "it", partial } });
    emit({ type: "inference.block.signature", seq: next(), data: { signature: SIGNATURE } });
    emit({
      type: "inference.thinking.redacted",
      seq: next(),
      data: { redactedThinking: { type: "redacted_thinking", data: REDACTED } },
    });
    emit({
      type: "tool.start",
      seq: next(),
      data: { call: { id: "call_1", name: "web_search", arguments: { query: "solana" } } },
    });
    emit({
      type: "tool.done",
      seq: next(),
      data: { result: { callId: "call_1", content: "x".repeat(10_000) } },
    });

    const frames = await live.readUntil((frame) => frame.type === "tool.result");
    await live.cancel();

    const reasoning = frames
      .filter((frame) => frame.type === "reasoning.delta")
      .map((frame) => frame["token"])
      .join("");
    expect(reasoning).toBe("Plan it");
    expect(frames).toContainEqual({ type: "step.started" });
    expect(frames).toContainEqual({
      type: "tool.call",
      callId: "call_1",
      name: "web_search",
      arguments: { query: "solana" },
    });
    const result = frames.find((frame) => frame.type === "tool.result");
    expect(result?.["callId"]).toBe("call_1");
    expect(result?.["isError"]).toBe(false);
    expect(String(result?.["content"]).length).toBeLessThan(4200);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(SIGNATURE);
    expect(wire).not.toContain(REDACTED);
  });

  test("reports an approval wait and its clearing as status frames", async () => {
    const live = openStream(await stream());
    await live.readUntil((frame) => frame.type === "snapshot");

    emit({
      type: "reactor.gate.blocked",
      seq: next(),
      data: { reason: "approval", gateId: "gate_1" },
    });
    await live.readUntil(
      (frame) => frame.type === "status" && frame["status"] === "waiting_approval",
    );
    emit({
      type: "reactor.gate.cleared",
      seq: next(),
      data: { gateId: "gate_1", reason: "resolved" },
    });
    const frames = await live.readUntil(
      (frame) => frame.type === "status" && frame["status"] === "busy",
    );
    await live.cancel();

    const statuses = frames.filter((frame) => frame.type === "status").map((f) => f["status"]);
    expect(statuses).toEqual(["waiting_approval", "busy"]);
  });

  test("releases its subscription when the browser disconnects", async () => {
    const live = openStream(await stream());
    await live.readUntil((frame) => frame.type === "snapshot");
    expect(subscribers.get(address)?.size).toBe(1);

    await live.cancel();
    await waitFor(() => (subscribers.get(address)?.size ?? 0) === 0);

    expect(subscribers.get(address)?.size ?? 0).toBe(0);
  });

  test("serves a run's saved steps with reasoning and tool traces", async () => {
    const live = openStream(await stream());
    await live.readUntil((frame) => frame.type === "snapshot");

    emit({ type: "inference.start", seq: next(), data: { model: "m" } });
    emit({
      type: "inference.done",
      seq: next(),
      data: {
        turn: {
          role: "assistant",
          model: "m",
          timestamp: Date.now(),
          content: [
            { type: "thinking", thinking: "Search first.", signature: SIGNATURE },
            {
              type: "tool_call",
              id: "call_2",
              name: "web_search",
              arguments: { query: "y".repeat(10_000) },
            },
          ],
        },
        usage,
        source,
      },
    });
    emit({
      type: "tool.done",
      seq: next(),
      data: { result: { callId: "call_2", content: "z".repeat(10_000), isError: true } },
    });
    emit({ type: "connector.reply", seq: next(), data: { content: "done" } });
    const frames = await live.readUntil((frame) => frame.type === "turn.committed");
    await live.cancel();
    expect(frames).toContainEqual({ type: "step.done", reasoning: "Search first." });

    const response = await app.fetch(new Request(`http://localhost/runs/${runId}/inference-turns`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runId: string;
      turns: { id: string; startedAt: string; parts: Record<string, unknown>[] }[];
    };
    expect(body.runId).toBe(runId);
    const saved = body.turns.at(-1);
    expect(saved?.parts.map((part) => part["kind"])).toEqual([
      "reasoning",
      "tool-call",
      "tool-result",
    ]);
    expect(saved?.parts[0]).toEqual({ kind: "reasoning", text: "Search first." });
    const call = saved?.parts[1];
    expect(call?.["callId"]).toBe("call_2");
    expect(JSON.stringify(call?.["arguments"]).length).toBeLessThan(4200);
    const result = saved?.parts[2];
    expect(result?.["isError"]).toBe(true);
    expect(String(result?.["content"]).length).toBeLessThan(4200);
    expect(JSON.stringify(body)).not.toContain(SIGNATURE);

    const since = encodeURIComponent(saved?.startedAt ?? "");
    const later = await app.fetch(
      new Request(`http://localhost/runs/${runId}/inference-turns?since=${since}`),
    );
    const laterBody = (await later.json()) as { turns: unknown[] };
    expect(laterBody.turns).toHaveLength(0);
  });

  test("answers 404 for a run outside the tenant", async () => {
    const otherRun = generateId("workflowRun");
    const streamed = await app.fetch(new Request(`http://localhost/runs/${otherRun}/stream`));
    const saved = await app.fetch(new Request(`http://localhost/runs/${otherRun}/inference-turns`));

    expect(streamed.status).toBe(404);
    expect(saved.status).toBe(404);
  });
});
