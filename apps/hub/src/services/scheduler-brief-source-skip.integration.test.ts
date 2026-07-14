import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import {
  briefSourcePreferenceKey,
  resolveEnabledBriefSources,
} from "@workbench/shared";
import { createGranolaTools } from "@workbench/tools-granola";
import { createScheduler, type ScheduledTriggerRow } from "./scheduler";
import { enrichHeartbeatTriggerPayload } from "../lib/heartbeat-trigger-payload";

// Exercises the real seam a live heartbeat fire drives end to end: scheduler
// tick -> per-fire member-preference read -> enrichHeartbeatTriggerPayload ->
// resolveEnabledBriefSources -> the granola tool's own enabledSources gate.
// Only the DB read (member preferences) and the granola tool's outbound
// network fetch are mocked; every function in between is the real one.

const HEARTBEAT_KIND = "heartbeat";
const AT_9 = Date.UTC(2026, 0, 2, 9, 0, 0);

function makeRow(
  overrides: Partial<ScheduledTriggerRow> = {},
): ScheduledTriggerRow {
  return {
    id: "sch-1",
    tenantId: "tenant-1",
    workflowKind: HEARTBEAT_KIND,
    hourUtc: 9,
    lastFiredDayUtc: null,
    ownerMemberPrincipalId: "principal-1",
    triggerPayload: { reason: "scheduled-heartbeat" },
    ...overrides,
  };
}

// Models the real `readMemberPreferences` return shape (a plain preferences
// map) without touching the DB — the DB read is the true boundary being
// mocked here, per the stored-preferences contract in member-preferences.ts.
function fireAndCapturePayload(
  storedPreferences: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  let capturedPayload: Record<string, unknown> | undefined;
  const scheduler = createScheduler({
    isTenantEnabled: async () => true,
    listSchedules: async () => [makeRow()],
    markFired: async () => {},
    startWorkflowRun: async (fire) => {
      const enabledSources = resolveEnabledBriefSources(storedPreferences);
      capturedPayload = enrichHeartbeatTriggerPayload(
        fire.triggerPayload,
        fire.kind,
        HEARTBEAT_KIND,
        enabledSources,
        fire.nowMs,
        fire.lastFiredDayUtc,
        fire.hourUtc,
        "scheduled",
        {
          userAddress: "usr_principal-1@workbench.example",
          userRefId: "principal-1",
        },
      );
      return { deploymentId: "dep-1", accepted: true, runId: "run-brief-skip-test" };
    },
  });

  return scheduler.tick(AT_9).then(() => capturedPayload);
}

describe("scheduler -> payload enrichment -> granola tool skip seam", () => {
  it("skips the granola network call end to end when the member disabled the granola brief source", async () => {
    const payload = await fireAndCapturePayload({
      [briefSourcePreferenceKey("granola")]: false,
    });

    expect(payload).toBeDefined();
    const enabledSources = payload?.enabledSources as string[];
    expect(enabledSources).toEqual([]);
    expect(payload?.createdAfter).toBe(
      new Date(AT_9 - 24 * 60 * 60 * 1000).toISOString(),
    );

    let fetchCalls = 0;
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "test-key",
        fetcher: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ notes: [], hasMore: false }), {
            status: 200,
          });
        },
      }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "granola_list_notes",
        arguments: { enabledSources },
      },
      new AbortController().signal,
    );

    expect(fetchCalls).toBe(0);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      notes: [],
      hasMore: false,
      skipped: true,
    });
  });

  it("attempts the granola network call end to end when the source stays enabled", async () => {
    const payload = await fireAndCapturePayload({
      [briefSourcePreferenceKey("granola")]: true,
    });

    expect(payload).toBeDefined();
    const enabledSources = payload?.enabledSources as string[];
    expect(enabledSources).toEqual(["granola"]);
    const createdAfter = payload?.createdAfter as string;
    expect(createdAfter).toBe(
      new Date(AT_9 - 24 * 60 * 60 * 1000).toISOString(),
    );

    let fetchCalls = 0;
    let requestedUrl: string | undefined;
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "test-key",
        fetcher: async (url) => {
          fetchCalls += 1;
          requestedUrl = url;
          return new Response(JSON.stringify({ notes: [], hasMore: false }), {
            status: 200,
          });
        },
      }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "granola_list_notes",
        arguments: { enabledSources, createdAfter },
      },
      new AbortController().signal,
    );

    expect(fetchCalls).toBe(1);
    expect(requestedUrl).toContain(
      `created_after=${encodeURIComponent(createdAfter)}`,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      notes: [],
      hasMore: false,
    });
  });
});
