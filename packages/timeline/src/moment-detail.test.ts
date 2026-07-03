import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  buildRunDetailQuery,
  buildToolCallDetailQuery,
  buildTurnDetailQuery,
  buildTurnPartsQuery,
  detailEnrichedKinds,
  isDetailEnrichedKind,
  MomentDetailSchema,
} from "./moment-detail";

const dialect = new PgDialect();
const scope = { id: "m1", tenantId: "ten", principalIds: ["prn_a", "prn_b"] };

function render(sql: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(sql);
}

describe("isDetailEnrichedKind", () => {
  test("recognizes exactly the kinds the detail layer enriches", () => {
    for (const kind of detailEnrichedKinds) {
      expect(isDetailEnrichedKind(kind)).toBe(true);
    }
    expect(isDetailEnrichedKind("grant")).toBe(false);
    expect(isDetailEnrichedKind("session")).toBe(false);
  });
});

describe("buildToolCallDetailQuery", () => {
  test("bridges analytics_event.tool_call_id to the turn_part call and result parts", () => {
    const { sql, params } = render(buildToolCallDetailQuery(scope));
    // The join that recovers the dropped tool I/O.
    expect(sql).toContain("from analytics_event ae");
    expect(sql).toContain("cp.metadata ->> 'callId' = ae.tool_call_id");
    expect(sql).toContain("rp.metadata ->> 'callId' = ae.tool_call_id");
    expect(sql).toContain("call_part.metadata -> 'arguments' as input");
    expect(sql).toContain("result_part.metadata -> 'content' as output");
    // CL-2738: both part joins are session-scoped to the anchor event so a
    // colliding provider callId cannot leak another session's tool I/O.
    expect(sql).toContain("cp.session_id = ae.session_id");
    expect(sql).toContain("rp.session_id = ae.session_id");
    // Deterministic single-part pick (no N×M cartesian on retried turns).
    expect(sql).toContain("left join lateral");
    expect(sql).toContain("order by cp.ordinal asc, cp.id asc");
    // Tenant + both principal ids are bound, never interpolated.
    expect(params).toEqual(["m1", "ten", "prn_a", "prn_b"]);
  });
});

describe("buildTurnDetailQuery / buildTurnPartsQuery", () => {
  test("derives duration and scopes the turn through its owning session", () => {
    const { sql } = render(buildTurnDetailQuery(scope));
    expect(sql).toContain("from inference_turn it");
    expect(sql).toContain("extract(epoch from (it.ended_at - it.started_at))");
    expect(sql).toContain("from agent_session s");
  });

  test("orders parts by ordinal for a single turn", () => {
    const { sql, params } = render(buildTurnPartsQuery("turn-1"));
    expect(sql).toContain("from turn_part tp");
    expect(sql).toContain("order by tp.ordinal asc");
    expect(params).toEqual(["turn-1"]);
  });
});

describe("buildRunDetailQuery", () => {
  test("reads the fact-table duration and scopes principal through the run record", () => {
    const { sql } = render(buildRunDetailQuery(scope));
    expect(sql).toContain("from workflow_run_record r");
    expect(sql).toContain("f.duration_ms as duration_ms");
    // CL-2738: LEFT JOIN so a run whose fact row lags still expands (null
    // duration) rather than 404-ing.
    expect(sql).toContain("left join workflow_run_fact f");
  });
});

describe("MomentDetailSchema", () => {
  test("accepts a tool-call detail and rejects a wrong-typed isError", () => {
    const ok = MomentDetailSchema({
      kind: "tool_call",
      id: "evt_1",
      toolCall: {
        toolName: "search",
        input: { q: "x" },
        output: "done",
        isError: false,
      },
    });
    expect(ok instanceof type.errors).toBe(false);

    const bad = MomentDetailSchema({
      kind: "tool_call",
      id: "evt_1",
      toolCall: { toolName: null, input: null, output: null, isError: "no" },
    });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("accepts a bare base for a non-enriched kind", () => {
    const ok = MomentDetailSchema({ kind: "session", id: "ses_1" });
    expect(ok instanceof type.errors).toBe(false);
  });
});
