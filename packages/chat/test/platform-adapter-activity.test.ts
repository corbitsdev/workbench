// Proves `createHubChatPlatform`'s `listWorkbenchActivity` — the bulk
// workbenchId -> sessionId resolution (workflow_run -> agent_session,
// mirroring `resolveFoldedRunSessionId`'s per-run semantics but in two
// `inArray` round trips for the whole list) and the two grouped SQL
// aggregates it runs against `session_mail` (latest message per
// session, and unread count per session gated by that workbench's own
// read cursor). The read-cursor merge math itself is unit-tested in
// `../src/workbench-activity.test.ts`; this file proves the query
// sequence against a database wires the right rows into it.
//
// `sessionService`/`assetService`/`sidecarRouter`/`eventCollectors`
// are never touched by `listWorkbenchActivity` (no lifecycle is
// configured here, so `createHubChatPlatform` never calls into any of
// them at construction time either) — they are cast stand-ins rather
// than the fuller fakes `platform-adapter.test.ts` builds for the
// launch/mail paths that do use them.
import { describe, expect, test } from "bun:test";
import { agentSession, sessionMail, workflowRun } from "@intx/db/schema";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import { createHubChatPlatform } from "../src/platform-adapter";

type Row = Record<string, unknown>;

/**
 * A minimal `db.select().from(table)` chain: `.where()`/`.orderBy()`
 * are no-ops (this fake pre-filters by table identity, not by
 * condition), and either resolves directly (awaited after `.where()`
 * or `.orderBy()`, matching `workflow_run`'s and `agent_session`'s
 * queries) or via `.groupBy()` (matching both `session_mail`
 * aggregates). `sessionMail` is queried twice with different grouped
 * results, so its row sets are consumed in call order.
 */
function fakeDb(plan: {
  workflowRunRows: Row[];
  agentSessionRows: Row[];
  sessionMailGroupedResults: Row[][];
}) {
  let sessionMailCallIndex = 0;

  function chainFor(rows: Row[]) {
    const resolved = Promise.resolve(rows);
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      groupBy: () => resolved,
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
    };
    return chain;
  }

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === workflowRun) return chainFor(plan.workflowRunRows);
        if (table === agentSession) return chainFor(plan.agentSessionRows);
        if (table === sessionMail) {
          const rows =
            plan.sessionMailGroupedResults[sessionMailCallIndex] ?? [];
          sessionMailCallIndex++;
          return chainFor(rows);
        }
        return chainFor([]);
      },
    }),
  };
}

function buildPlatform(plan: Parameters<typeof fakeDb>[0]) {
  return createHubChatPlatform({
    hubPublicKey: "hub-key",
    toolGrantsForPins: () => [],
    db: fakeDb(plan) as never,
    noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
    sessionService: {} as unknown as SessionService,
    assetService: {} as unknown as AssetService,
    sidecarRouter: {} as unknown as SidecarRouter,
    eventCollectors: {} as unknown as EventCollectorRegistry,
  });
}

describe("listWorkbenchActivity", () => {
  test("resolves each workbench's session via its run's principal and reports latest activity + unread count", async () => {
    const platform = buildPlatform({
      workflowRunRows: [
        { id: "ch_general", principalId: "prn_general_host" },
        { id: "ch_random", principalId: "prn_random_host" },
      ],
      agentSessionRows: [
        { id: "sess_general", principalId: "prn_general_host" },
        { id: "sess_random", principalId: "prn_random_host" },
      ],
      sessionMailGroupedResults: [
        // 1st sessionMail call: MAX(createdAt) per session.
        [
          {
            sessionId: "sess_general",
            lastActivityAt: new Date("2026-01-01T00:05:00.000Z"),
          },
          {
            sessionId: "sess_random",
            lastActivityAt: new Date("2026-01-01T00:01:00.000Z"),
          },
        ],
        // 2nd sessionMail call: COUNT(*) per session, newer than cursor.
        [{ sessionId: "sess_general", unreadCount: 2 }],
      ],
    });

    const result = await platform.listWorkbenchActivity({
      tenantId: "tnt_1",
      workbenches: [
        {
          workbenchId: "ch_general",
          sinceCreatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          workbenchId: "ch_random",
          sinceCreatedAt: "2026-01-01T00:00:30.000Z",
        },
      ],
    });

    expect(result).toEqual({
      ch_general: {
        unreadCount: 2,
        lastActivityAt: "2026-01-01T00:05:00.000Z",
      },
      ch_random: { unreadCount: 0, lastActivityAt: "2026-01-01T00:01:00.000Z" },
    });
  });

  test("omits a workbench whose run has no principal, rather than fabricating a zero", async () => {
    const platform = buildPlatform({
      workflowRunRows: [{ id: "ch_orphaned", principalId: null }],
      agentSessionRows: [],
      sessionMailGroupedResults: [[], []],
    });

    const result = await platform.listWorkbenchActivity({
      tenantId: "tnt_1",
      workbenches: [{ workbenchId: "ch_orphaned" }],
    });

    expect(result).toEqual({});
  });

  test("an empty workbench list makes no queries and returns immediately", async () => {
    const platform = buildPlatform({
      workflowRunRows: [],
      agentSessionRows: [],
      sessionMailGroupedResults: [],
    });

    const result = await platform.listWorkbenchActivity({
      tenantId: "tnt_1",
      workbenches: [],
    });

    expect(result).toEqual({});
  });
});
