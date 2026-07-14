import { type } from "arktype";
import { getLogger } from "@intx/log";
import { createGranolaTools } from "@workbench/tools-granola";
import type { AgentTool } from "@intx/agent";
import type { GranolaCallJobRow } from "../db/schema";
import { resolveTenantToolCredential } from "../lib/member-tool-credential";
import type { HubDb } from "../db";
import { GRANOLA_WORKSPACE_SOURCE_KEY } from "./inbox-sources/granola-workspace";
import {
  GranolaCallSchema,
  type GranolaCall,
  type GranolaCallPipeline,
} from "./granola-call-pipeline";
import type { GranolaCallJobQueue } from "./granola-call-job-queue";

const log = getLogger(["services", "granola-call-job-runner"]);

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 5;

const TranscriptItem = type({ "text?": "string" });
const FullNote = type({
  id: "string",
  "title?": "string | null",
  "created_at?": "string",
  "summary?": "string",
  "participants?": "string[]",
  "transcript?": TranscriptItem.array(),
});

type StringTool = Extract<AgentTool, { kind: "string" }>;

function findTool(tools: AgentTool[], name: string): StringTool {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`granola call job runner: missing tool ${name}`);
  if (tool.kind !== "string") {
    throw new Error(`granola call job runner: tool ${name} is not string-kind`);
  }
  return tool;
}

async function callTool(
  tool: StringTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const result = await tool.handler(args, signal);
  return JSON.parse(result);
}

function transcriptText(
  transcript: { text?: string }[] | undefined,
): string | undefined {
  if (!transcript || transcript.length === 0) return undefined;
  const text = transcript
    .map((t) => t.text ?? "")
    .filter((t) => t !== "")
    .join("\n");
  return text === "" ? undefined : text;
}

function toGranolaCall(note: typeof FullNote.infer): GranolaCall {
  const call: GranolaCall = { id: note.id };
  if (note.title !== undefined) call.title = note.title;
  if (note.summary !== undefined) call.summary = note.summary;
  if (note.participants !== undefined) call.participants = note.participants;
  if (note.created_at !== undefined) call.createdAt = note.created_at;
  const text = transcriptText(note.transcript);
  if (text !== undefined) call.transcript = text;
  const parsed = GranolaCallSchema(call);
  if (parsed instanceof type.errors) {
    throw new Error(
      `granola call job runner: constructed call failed validation: ${parsed.summary}`,
    );
  }
  return parsed;
}

async function fetchFullNote(
  db: HubDb,
  tenantId: string,
  noteId: string,
  signal: AbortSignal,
): Promise<GranolaCall> {
  const credential = await resolveTenantToolCredential(
    db,
    tenantId,
    GRANOLA_WORKSPACE_SOURCE_KEY,
  );
  if (!credential) {
    throw new Error(
      `granola call job runner: no tenant credential for ${tenantId}`,
    );
  }
  const tools = createGranolaTools({
    apiKey: credential.apiKey,
    ...(credential.baseURL ? { baseUrl: credential.baseURL } : {}),
  });
  const getTool = findTool(tools, "granola_get_note");
  const fullRaw = await callTool(getTool, { noteId }, signal);
  const fullNote = FullNote(fullRaw);
  if (fullNote instanceof type.errors) {
    throw new Error(
      `granola call job runner: bad note response for ${noteId}: ${fullNote.summary}`,
    );
  }
  return toGranolaCall(fullNote);
}

export interface GranolaCallJobRunnerDeps {
  db: HubDb;
  queue: GranolaCallJobQueue;
  pipeline: GranolaCallPipeline;
  tickIntervalMs?: number;
  batchSize?: number;
}

export interface GranolaCallJobRunner {
  start(): void;
  stop(): void;
  /** Drains one batch of due jobs; exported for tests so a run can be awaited
   * deterministically instead of racing the interval timer. */
  runOnce(): Promise<void>;
}

async function processJob(
  deps: GranolaCallJobRunnerDeps,
  job: GranolaCallJobRow,
  signal: AbortSignal,
): Promise<void> {
  try {
    const note = await fetchFullNote(deps.db, job.tenantId, job.noteId, signal);
    const result = await deps.pipeline.processCall({
      tenantId: job.tenantId,
      note,
      signal,
    });
    log.info("granola call job: processed {noteId} -> {status}", {
      noteId: job.noteId,
      tenantId: job.tenantId,
      status: result.status,
    });
    await deps.queue.complete(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.queue.fail(job.id, job.attempts + 1, message);
  }
}

export function createGranolaCallJobRunner(
  deps: GranolaCallJobRunnerDeps,
): GranolaCallJobRunner {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  async function runOnce(): Promise<void> {
    const jobs = await deps.queue.claimDue(batchSize);
    if (jobs.length === 0) return;
    const controller = new AbortController();
    for (const job of jobs) {
      await processJob(deps, job, controller.signal);
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((err) => {
        log.error("granola call job runner: tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }, tickIntervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, stop, runOnce };
}
