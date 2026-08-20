// Fires a routine occurrence on demand (CL-6339): no new product
// surface, just the Nth caller of the same "run now" route the
// Routines UI's own button already hits — `POST
// /routines/:id/run` (`packages/routines/src/routes.ts`), which
// delegates to `launchAndCorrelate`, the exact launcher a scheduled
// trigger fire calls too. This lets an eval case force a scheduled
// automation to run right now instead of waiting for a real clock
// tick, and grades the result with the same `Turn`/`Scorer` contract
// every chat turn already uses — a routine's launch is a
// `workflow_run`/`inference_turn` chain keyed by the same `runId`
// `readAllToolCalls` (./trace.ts) already reads for a chat turn.
import type { Turn } from "../types.ts";
import { readAllToolCalls, type SqlClientLike } from "./trace.ts";

export interface FireRoutineApiResult {
  readonly status: number;
  readonly data: unknown;
}

export interface FireRoutineDeps {
  api(
    base: string,
    method: string,
    route: string,
    body?: unknown,
    cookies?: string[],
  ): Promise<FireRoutineApiResult>;
  readonly hubUrl: string;
  readonly tenantId: string;
  readonly cookies: string[];
  readonly sql: SqlClientLike;
}

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

interface RoutineRunListItem {
  readonly runId: string;
  readonly run?: Record<string, unknown>;
}

function findRun(
  items: unknown[],
  runId: string,
): RoutineRunListItem | undefined {
  return (items as RoutineRunListItem[]).find((item) => item.runId === runId);
}

/**
 * Posts an unscheduled "run now" for `routineId`, polls `GET
 * /routines/:id/runs` until that run's row appears, reads the fired
 * run's tool calls off the platform's own tables (same read a chat
 * turn's tool calls use), and returns a `Turn` so the result composes
 * with every existing scorer unchanged. Polling times out loudly —
 * never resolves with a fabricated empty `Turn`.
 */
export async function fireRoutineNow(
  deps: FireRoutineDeps,
  routineId: string,
  routineName: string,
  options?: { pollTimeoutMs?: number; pollIntervalMs?: number },
): Promise<Turn> {
  const { api, cookies, hubUrl, sql, tenantId } = deps;
  const pollTimeoutMs = options?.pollTimeoutMs ?? 60_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 1_000;

  const runRes = await api(
    hubUrl,
    "POST",
    `/api/tenants/${tenantId}/routines/${routineId}/run`,
    {},
    cookies,
  );
  if (runRes.status !== 201) {
    throw new Error(
      `fireRoutineNow("${routineName}"): POST .../run returned ${String(runRes.status)}: ${JSON.stringify(runRes.data)}`,
    );
  }
  const runId = stringField(runRes.data, "runId", `run "${routineName}" now`);

  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const listRes = await api(
      hubUrl,
      "GET",
      `/api/tenants/${tenantId}/routines/${routineId}/runs`,
      undefined,
      cookies,
    );
    if (listRes.status !== 200) {
      throw new Error(
        `fireRoutineNow("${routineName}"): GET .../runs returned ${String(listRes.status)}: ${JSON.stringify(listRes.data)}`,
      );
    }
    const items = arrayField(
      listRes.data,
      "items",
      `list runs for "${routineName}"`,
    );
    const found = findRun(items, runId);
    if (found !== undefined) {
      const toolCalls = await readAllToolCalls(sql, tenantId, runId);
      return {
        human: `(routine fired: ${routineName})`,
        replyText: found.run !== undefined ? JSON.stringify(found.run) : "",
        toolCalls,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `fireRoutineNow("${routineName}"): run "${runId}" never appeared in ` +
          `GET .../runs within ${String(pollTimeoutMs)}ms; last-seen: ${JSON.stringify(items)}`,
      );
    }
    await Bun.sleep(pollIntervalMs);
  }
}
