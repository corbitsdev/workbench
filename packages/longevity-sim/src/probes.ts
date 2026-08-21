// Pure parsers (unit-tested, no network/DB) plus the network+DB
// collector that turns one checkpoint's live reads into a
// `CheckpointRecord`. The collector talks only to the booted stack's
// public HTTP surface, its scratch Postgres, and `ps` against the two
// pids `stack.ts` resolved at boot.

import { readFile } from "node:fs/promises";

import { percentile, type CheckpointRecord } from "./metrics";
import { api, expectStatus } from "../../../scripts/e2e/harness.ts";
import { arrayField, type LongevityStack } from "./stack";

/** Parses `ps -o rss= -p <pid>` output (kB on both Linux and macOS) into
 * bytes. Returns 0 for blank/unparseable output — a dead or unresolved
 * pid, never a thrown error, since a probe must never abort a
 * checkpoint over a missing RSS reading. */
export function parseRssKb(psOutput: string): number {
  const trimmed = psOutput.trim();
  if (trimmed === "") return 0;
  const kb = Number(trimmed.split(/\s+/)[0]);
  if (!Number.isFinite(kb) || kb < 0) return 0;
  return kb * 1024;
}

export interface LogSignatureCounts {
  collectorFailures: number;
  fanoutFailures: number;
  deadLetters: number;
  schedulerFailures: number;
}

const COLLECTOR_FAILURE_SIGNATURES = [
  "Failed to persist event",
  "turn_part insert failed",
];
const FANOUT_FAILURE_SIGNATURE = "Routing failed for workbench";
const DEAD_LETTER_SIGNATURE = "dead-lettered";
const SCHEDULER_FAILURE_SIGNATURE = "scheduled fire of routine";

function countOccurrences(log: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = log.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = log.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Counts the log-signature families the campaign treats as
 * degradation evidence, over the full accumulated hub log (cumulative
 * across restarts — see `stack.ts`'s continuous flush to `hubLogPath`).
 * "scheduled fire of routine" only counts as a failure when paired with
 * a failure-shaped suffix on the same line, never a routine's ordinary
 * successful fire log line. */
export function countLogSignatures(log: string): LogSignatureCounts {
  let collectorFailures = 0;
  for (const signature of COLLECTOR_FAILURE_SIGNATURES) {
    collectorFailures += countOccurrences(log, signature);
  }
  const fanoutFailures = countOccurrences(log, FANOUT_FAILURE_SIGNATURE);
  const deadLetters = countOccurrences(log, DEAD_LETTER_SIGNATURE);

  let schedulerFailures = 0;
  for (const line of log.split("\n")) {
    if (!line.includes(SCHEDULER_FAILURE_SIGNATURE)) continue;
    if (/fail|error|reject/i.test(line)) schedulerFailures += 1;
  }

  return { collectorFailures, fanoutFailures, deadLetters, schedulerFailures };
}

async function rssBytes(pid: number | undefined): Promise<number> {
  if (pid === undefined) return 0;
  const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return parseRssKb(output);
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await run();
  return { ms: performance.now() - start, value };
}

export interface CheckpointWindow {
  atMessages: number;
  wallClockStartedAtMs: number;
  sendLatenciesMs: number[];
  turnLatenciesMs: number[];
  firstTokenLatenciesMs: number[];
  sendFailures: number;
  turnFailures: number;
  routineFiresTotal: number;
  routineFiresAccepted: number;
}

export function newCheckpointWindow(
  atMessages: number,
  campaignStartedAtMs: number,
): CheckpointWindow {
  return {
    atMessages,
    wallClockStartedAtMs: campaignStartedAtMs,
    sendLatenciesMs: [],
    turnLatenciesMs: [],
    firstTokenLatenciesMs: [],
    sendFailures: 0,
    turnFailures: 0,
    routineFiresTotal: 0,
    routineFiresAccepted: 0,
  };
}

/**
 * Collects one checkpoint's `CheckpointRecord`: db size, newest-page and
 * 5-page-deep message read latency, a workbench list read, both
 * processes' RSS, cumulative log-signature counts, and the window's own
 * latency arrays. `sendFailures`/`turnFailures`/`routineFiresTotal`/
 * `routineFiresAccepted` are cumulative counters the campaign engine
 * threads through — this collector only folds them into the record, it
 * never resets them (that is `executeCampaign`'s job between
 * checkpoints).
 */
export async function collectCheckpoint(
  stack: LongevityStack,
  window: CheckpointWindow,
  cumulative: {
    collectorFailures: number;
    sendFailures: number;
    turnFailures: number;
    routineFiresTotal: number;
    routineFiresAccepted: number;
  },
): Promise<CheckpointRecord> {
  const dbSizeRows = await stack.sql.unsafe(
    "SELECT pg_database_size(current_database()) AS bytes",
  );
  const dbSizeBytes = Number(dbSizeRows[0]?.["bytes"] ?? 0);

  const pageRes = await timed(async () => {
    const res = await api(
      stack.baseUrl,
      "GET",
      `/api/tenants/${stack.tenantId}/chat/workbenches/${stack.workbenchId}/messages`,
      undefined,
      stack.ownerCookies,
    );
    expectStatus("checkpoint: newest message page", res, 200);
    return res;
  });

  let deepCursor: string | undefined;
  let deepMs = 0;
  for (let page = 0; page < 5; page++) {
    const pageResult = await timed(async () => {
      const route =
        deepCursor === undefined
          ? `/api/tenants/${stack.tenantId}/chat/workbenches/${stack.workbenchId}/messages`
          : `/api/tenants/${stack.tenantId}/chat/workbenches/${stack.workbenchId}/messages?cursor=${encodeURIComponent(deepCursor)}`;
      const res = await api(
        stack.baseUrl,
        "GET",
        route,
        undefined,
        stack.ownerCookies,
      );
      expectStatus(`checkpoint: message page ${page}`, res, 200);
      return res;
    });
    deepMs += pageResult.ms;
    const data = pageResult.value.data as { nextCursor?: string };
    if (data.nextCursor === undefined) break;
    deepCursor = data.nextCursor;
  }

  const workbenchListRes = await timed(async () => {
    const res = await api(
      stack.baseUrl,
      "GET",
      `/api/tenants/${stack.tenantId}/chat/workbenches`,
      undefined,
      stack.ownerCookies,
    );
    expectStatus("checkpoint: workbench list", res, 200);
    arrayField(res.data, "items", "checkpoint: workbench list");
    return res;
  });

  const [hubRssBytes, sidecarRssBytes] = await Promise.all([
    rssBytes(stack.hubPid()),
    rssBytes(stack.sidecarPid()),
  ]);

  const hubLog = await readFile(stack.hubLogPath, "utf8").catch(() => "");
  const signatures = countLogSignatures(hubLog);

  return {
    atMessages: window.atMessages,
    wallClockMs: Date.now() - window.wallClockStartedAtMs,
    sendLatencyP50Ms: percentile(window.sendLatenciesMs, 50),
    sendLatencyP95Ms: percentile(window.sendLatenciesMs, 95),
    sendLatencyMaxMs: window.sendLatenciesMs.reduce(
      (m, v) => Math.max(m, v),
      0,
    ),
    turnLatencyP50Ms: percentile(window.turnLatenciesMs, 50),
    turnLatencyP95Ms: percentile(window.turnLatenciesMs, 95),
    turnCount: window.turnLatenciesMs.length,
    firstTokenP50Ms: percentile(window.firstTokenLatenciesMs, 50),
    dbSizeBytes,
    messagePageMs: pageRes.ms,
    messagePageDeepMs: deepMs,
    workbenchListMs: workbenchListRes.ms,
    hubRssBytes,
    sidecarRssBytes,
    collectorFailures:
      signatures.collectorFailures + cumulative.collectorFailures,
    routineFiresTotal: cumulative.routineFiresTotal,
    routineFiresAccepted: cumulative.routineFiresAccepted,
    sendFailures: cumulative.sendFailures,
    turnFailures: cumulative.turnFailures,
  };
}
