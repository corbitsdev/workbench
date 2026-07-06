import { type } from "arktype";
import { sql, type SQL } from "drizzle-orm";

// The detail-expansion layer. The paginated timeline stays lean (id, kind,
// sourceTable, timestamp, summary); when a single moment is OPENED, one of
// these per-kind queries joins the rich source columns the shallow projection
// discards. Tool inputs/outputs and inference-turn parts live in the
// interchange-owned `turn_part` table — read-only here, never written.

/** A tool call's real recorded input, output, and error flag. */
export const MomentToolCallDetailSchema = type({
  /** Tool name from the call part, or null when the call part is absent. */
  toolName: "string | null",
  /** Recorded arguments (jsonb) — null when no `call` part was persisted. */
  input: "unknown",
  /** Recorded result content (jsonb) — null when no `result` part exists. */
  output: "unknown",
  isError: "boolean",
});
export type MomentToolCallDetail = typeof MomentToolCallDetailSchema.infer;

/** One persisted part of an inference turn, ordered by ordinal. */
export const MomentTurnPartSchema = type({
  type: "string",
  content: "string | null",
  /** Tool name, present only on tool `call` parts. */
  "toolName?": "string | null",
});
export type MomentTurnPart = typeof MomentTurnPartSchema.infer;

/** An inference turn's model, wall-clock duration, and ordered parts. */
export const MomentTurnDetailSchema = type({
  model: "string | null",
  /** endedAt - startedAt in ms; null while the turn is still running. */
  durationMs: "number | null",
  parts: MomentTurnPartSchema.array(),
});
export type MomentTurnDetail = typeof MomentTurnDetailSchema.infer;

/** A workflow run's recorded duration and outcome from the fact table. */
export const MomentRunDetailSchema = type({
  durationMs: "number | null",
  outcome: "string | null",
});
export type MomentRunDetail = typeof MomentRunDetailSchema.infer;

/**
 * The expanded detail for one moment. Only the block matching the moment's
 * kind is present. A kind we do not enrich (session, memory, grant, …) has
 * nothing to expand and 404s rather than echoing an unverified id. A block
 * being present but its fields null means "the join found the row but the
 * rich column was empty" — an honest gap, not a fabricated value.
 */
export const MomentDetailSchema = type({
  kind: "string",
  id: "string",
  "toolCall?": MomentToolCallDetailSchema,
  "turn?": MomentTurnDetailSchema,
  "run?": MomentRunDetailSchema,
});
export type MomentDetail = typeof MomentDetailSchema.infer;

/** Kinds the detail layer can currently enrich. */
export const detailEnrichedKinds = [
  "tool_call",
  "inference_turn",
  "workflow_run",
] as const;
export type DetailEnrichedKind = (typeof detailEnrichedKinds)[number];

export function isDetailEnrichedKind(kind: string): kind is DetailEnrichedKind {
  return (detailEnrichedKinds as readonly string[]).includes(kind);
}

function inSet(column: SQL, values: readonly string[]): SQL {
  if (values.length === 1) {
    return sql`${column} = ${values[0]}`;
  }
  const bound = values.map((value) => sql`${value}`);
  return sql`${column} in (${sql.join(bound, sql`, `)})`;
}

export type MomentDetailScope = {
  id: string;
  tenantId: string;
  principalIds: readonly string[];
};

// Bridge analytics_event.tool_call_id -> turn_part.metadata->>'callId'. The
// analytics row is tenant/principal-scoped (so cross-principal detail can't
// leak); the turn_part join recovers the arguments (call part) and result
// content (result part) the shallow tool_call projection dropped.
//
// callId is PROVIDER-assigned and NOT globally unique (a local model can emit
// "call_1"), so the part joins MUST also be scoped to the anchor's session —
// `turn_part.session_id = ae.session_id` — or a colliding callId in another
// session (another tenant/principal) would leak that session's tool I/O
// (CL-2738). The anchor event is already tenant+principal-scoped, and
// analytics_event.session_id is always populated (the subscriber throws
// without it), so tying the part to the anchor's session closes the leak.
//
// Each part is resolved through a LATERAL subquery that deterministically
// picks a single part (ordered by ordinal, then id) instead of a plain LEFT
// JOIN: retried turns can persist multiple call/result parts for one callId,
// and independent left joins would produce an N×M cartesian whose `limit 1`
// picks arbitrarily. The lateral keeps output and isError from the SAME
// result part.
export function buildToolCallDetailQuery(scope: MomentDetailScope): SQL {
  return sql`
    select
      call_part.metadata ->> 'name' as tool_name,
      call_part.metadata -> 'arguments' as input,
      result_part.metadata -> 'content' as output,
      coalesce((result_part.metadata ->> 'isError')::boolean, false) as is_error
    from analytics_event ae
    left join lateral (
      select cp.metadata as metadata
      from turn_part cp
      where cp.type = 'tool'
        and cp.metadata ->> 'kind' = 'call'
        and cp.metadata ->> 'callId' = ae.tool_call_id
        and cp.session_id = ae.session_id
      order by cp.ordinal asc, cp.id asc
      limit 1
    ) call_part on true
    left join lateral (
      select rp.metadata as metadata
      from turn_part rp
      where rp.type = 'tool'
        and rp.metadata ->> 'kind' = 'result'
        and rp.metadata ->> 'callId' = ae.tool_call_id
        and rp.session_id = ae.session_id
      order by rp.ordinal asc, rp.id asc
      limit 1
    ) result_part on true
    where ae.id = ${scope.id}
      and ae.event_type = 'tool_call'
      and ae.tenant_id = ${scope.tenantId}
      and ${inSet(sql`ae.principal_id`, scope.principalIds)}
    limit 1`;
}

// Duration is derived (endedAt - startedAt); no fact table carries a turn
// duration today. Principal scope rides through the owning agent_session.
export function buildTurnDetailQuery(scope: MomentDetailScope): SQL {
  return sql`
    select
      it.model as model,
      case
        when it.ended_at is not null
        then extract(epoch from (it.ended_at - it.started_at)) * 1000
        else null
      end as duration_ms
    from inference_turn it
    where it.id = ${scope.id}
      and it.tenant_id = ${scope.tenantId}
      and exists (
        select 1 from agent_session s
        where s.id = it.session_id
        and ${inSet(sql`s.principal_id`, scope.principalIds)}
      )
    limit 1`;
}

// Parts are only fetched after the turn itself resolves in scope, so this
// bare turn_id lookup cannot leak an out-of-scope turn's parts.
export function buildTurnPartsQuery(turnId: string): SQL {
  return sql`
    select tp.type as type, tp.content as content, tp.metadata as metadata
    from turn_part tp
    where tp.turn_id = ${turnId}
    order by tp.ordinal asc`;
}

// Real per-run duration + outcome from the analytics fact table. Principal
// scope rides through workflow_run_record (the fact table has no principal).
// The fact row is LEFT JOINed: a run visible in the timeline whose fact row
// has not been projected yet must still expand to its base info with an
// honestly-null duration/outcome, not dead-end on a 404 (CL-2738).
export function buildRunDetailQuery(scope: MomentDetailScope): SQL {
  return sql`
    select f.duration_ms as duration_ms, f.outcome as outcome
    from workflow_run_record r
    left join workflow_run_fact f
      on f.run_id = r.id
      and f.tenant_id = r.tenant_id
    where r.id = ${scope.id}
      and r.tenant_id = ${scope.tenantId}
      and ${inSet(sql`r.principal_id`, scope.principalIds)}
    limit 1`;
}
