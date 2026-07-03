import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { type } from "arktype";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";

const { principal, user, agent, agentInstance } = intxSchema;

export const ACTOR_SEARCH_MIN_QUERY_LENGTH = 2;
export const ACTOR_SEARCH_MAX_RESULTS = 20;
const MAX_QUERY_LENGTH = 200;

export const ActorSchema = type({
  id: "string",
  kind: "'user' | 'agent'",
  displayName: "string",
  "email?": "string",
  status: "string",
});
export type Actor = typeof ActorSchema.infer;

export const ActorSearchResponseSchema = type({ actors: ActorSchema.array() });
export type ActorSearchResponse = typeof ActorSearchResponseSchema.infer;

export class ActorSearchQueryTooShortError extends Error {
  constructor() {
    super(`Query must be at least ${ACTOR_SEARCH_MIN_QUERY_LENGTH} characters`);
    this.name = "ActorSearchQueryTooShortError";
  }
}

export interface ActorSearchParams {
  tenantId: string;
  query: string;
  limit?: number;
}

// Escape the LIKE metacharacters a user can type so a literal `%`/`_` is
// matched as itself, not as a wildcard (mirrors the search service).
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

// Tenant scoping by construction: this is the ONLY place in the module that
// builds a WHERE clause over principals, and it emits the tenant predicate
// unconditionally before anything else. Every source query below must pass
// through it — there is no code path that can produce an unscoped query.
function tenantScopedActorFilter(
  tenantId: string,
  kind: "user" | "agent",
  match: SQL,
): SQL {
  const scoped = and(
    eq(principal.tenantId, tenantId),
    eq(principal.kind, kind),
    match,
  );
  if (scoped === undefined) {
    throw new Error("Actor filter construction produced no predicate");
  }
  return scoped;
}

// Relevance rank: exact > prefix > contains (the WHERE clause has already
// constrained rows to a contains-match, so the floor is 1).
function rankColumn(
  column: Parameters<typeof ilike>[0],
  query: string,
  likePrefix: string,
) {
  return sql<number>`CASE WHEN lower(${column}) = ${query} THEN 3 WHEN ${column} ILIKE ${likePrefix} THEN 2 ELSE 1 END`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return ACTOR_SEARCH_MAX_RESULTS;
  }
  return Math.min(Math.max(1, Math.floor(limit)), ACTOR_SEARCH_MAX_RESULTS);
}

/**
 * Searches principals (user and agent kinds) in the active tenant by display
 * name / email. Enforces {@link ACTOR_SEARCH_MIN_QUERY_LENGTH} before touching
 * the db and caps results at {@link ACTOR_SEARCH_MAX_RESULTS} so an
 * `ILIKE '%x%'` can never become an unbounded enumeration.
 *
 * Suspended/deactivated principals and ended agent instances are searchable
 * BY DESIGN: this feeds the activity-timeline actor picker, where historical
 * actors must remain findable; `status` is returned so callers can render or
 * filter them. The agent join matches INSTANCE principals only
 * (`principal.refId = agentInstance.id`) — also by design: activity rows
 * attribute to an instance's synthetic principal, never to a definition-level
 * principal (`refId = agent.id`), so widening the join would only surface
 * actors that can have no timeline.
 */
export async function searchActors(
  db: HubDb,
  params: ActorSearchParams,
): Promise<ActorSearchResponse> {
  const query = params.query.trim().slice(0, MAX_QUERY_LENGTH).toLowerCase();
  if (query.length < ACTOR_SEARCH_MIN_QUERY_LENGTH) {
    throw new ActorSearchQueryTooShortError();
  }

  const limit = clampLimit(params.limit);
  const like = `%${escapeLike(query)}%`;
  const prefix = `${escapeLike(query)}%`;

  const userMatch = or(ilike(user.name, like), ilike(user.email, like));
  if (userMatch === undefined) {
    throw new Error("User match predicate construction failed");
  }

  const userRows = await db
    .select({
      id: principal.id,
      status: principal.status,
      name: user.name,
      email: user.email,
      rank: rankColumn(user.name, query, prefix),
    })
    .from(principal)
    .innerJoin(user, eq(principal.refId, user.id))
    .where(tenantScopedActorFilter(params.tenantId, "user", userMatch))
    .orderBy(desc(rankColumn(user.name, query, prefix)), asc(user.name))
    .limit(limit);

  const agentRows = await db
    .select({
      id: principal.id,
      status: principal.status,
      name: agent.name,
      rank: rankColumn(agent.name, query, prefix),
    })
    .from(principal)
    .innerJoin(agentInstance, eq(principal.refId, agentInstance.id))
    .innerJoin(agent, eq(agentInstance.agentId, agent.id))
    .where(
      tenantScopedActorFilter(
        params.tenantId,
        "agent",
        ilike(agent.name, like),
      ),
    )
    .orderBy(desc(rankColumn(agent.name, query, prefix)), asc(agent.name))
    .limit(limit);

  const merged = [
    ...userRows.map((row) => ({
      rank: row.rank,
      actor: {
        id: row.id,
        kind: "user" as const,
        displayName: row.name,
        email: row.email,
        status: row.status,
      },
    })),
    ...agentRows.map((row) => ({
      rank: row.rank,
      actor: {
        id: row.id,
        kind: "agent" as const,
        displayName: row.name,
        status: row.status,
      },
    })),
  ]
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        a.actor.displayName.localeCompare(b.actor.displayName),
    )
    .slice(0, limit)
    .map((entry) => entry.actor);

  const validated = ActorSearchResponseSchema({ actors: merged });
  if (validated instanceof type.errors) {
    throw new Error(`Invalid actor search result shape: ${validated.summary}`);
  }
  return validated;
}

export interface GetActorByIdParams {
  tenantId: string;
  principalId: string;
}

/**
 * Resolves a single principal to its {@link Actor} identity within a tenant, or
 * `null` when no such principal exists in that tenant. Powers the deep-linkable
 * actor detail page, which must render identity (name, kind, status, email)
 * from the principal id alone. Tenant-scoped by construction — the principal
 * row must match `tenantId` before either identity join runs. The agent join
 * mirrors {@link searchActors}: it matches INSTANCE principals only
 * (`principal.refId = agentInstance.id`), the only kind that can carry a
 * timeline.
 */
export async function getActorById(
  db: HubDb,
  params: GetActorByIdParams,
): Promise<Actor | null> {
  const [principalRow] = await db
    .select({
      id: principal.id,
      kind: principal.kind,
      status: principal.status,
    })
    .from(principal)
    .where(
      and(
        eq(principal.id, params.principalId),
        eq(principal.tenantId, params.tenantId),
      ),
    )
    .limit(1);

  if (principalRow === undefined) return null;

  if (principalRow.kind === "user") {
    const [userRow] = await db
      .select({ name: user.name, email: user.email })
      .from(principal)
      .innerJoin(user, eq(principal.refId, user.id))
      .where(eq(principal.id, principalRow.id))
      .limit(1);
    if (userRow === undefined) return null;
    const actor = ActorSchema({
      id: principalRow.id,
      kind: "user",
      displayName: userRow.name,
      email: userRow.email,
      status: principalRow.status,
    });
    if (actor instanceof type.errors) {
      throw new Error(`Invalid actor shape: ${actor.summary}`);
    }
    return actor;
  }

  if (principalRow.kind === "agent") {
    const [agentRow] = await db
      .select({ name: agent.name })
      .from(principal)
      .innerJoin(agentInstance, eq(principal.refId, agentInstance.id))
      .innerJoin(agent, eq(agentInstance.agentId, agent.id))
      .where(eq(principal.id, principalRow.id))
      .limit(1);
    if (agentRow === undefined) return null;
    const actor = ActorSchema({
      id: principalRow.id,
      kind: "agent",
      displayName: agentRow.name,
      status: principalRow.status,
    });
    if (actor instanceof type.errors) {
      throw new Error(`Invalid actor shape: ${actor.summary}`);
    }
    return actor;
  }

  return null;
}
