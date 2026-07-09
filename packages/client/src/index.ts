// @workbench/client — framework-agnostic data-access seam for the workbench hub.
//
// These functions are the reusable boundary: any app or demo can point them at
// its own hub by passing a `baseUrl` and/or a custom `fetch`. They return clean
// `@workbench/shared` domain types and contain no presentation logic.

import { type } from "arktype";
import { Artifact, SessionStatusSchema } from "@workbench/shared";
import type { ArtifactWithSession, WorkflowSummary } from "@workbench/shared";
import { MomentDetailSchema, TimelineEntrySchema } from "@workbench/timeline";
import type {
  MomentDetail,
  TimelineEntry,
  TimelineEntryKind,
} from "@workbench/timeline";

export { MomentDetailSchema, TimelineEntrySchema };
export type { MomentDetail, TimelineEntry, TimelineEntryKind };

/**
 * Serializable subset of {@link ClientOptions}. `fetch` and `init` carry
 * non-serializable members (a function, an `AbortSignal`) and cannot be
 * expressed in arktype, so they are intersected as a plain type below.
 */
export const ClientOptionsSchema = type({
  /**
   * Origin of the hub, e.g. `https://hub.example.com`. When omitted, requests
   * are made relative to the current origin (same-origin deployment).
   */
  "baseUrl?": "string",
});

/** Configuration for a client call. All fields are optional. */
export type ClientOptions = typeof ClientOptionsSchema.infer & {
  /** Custom fetch implementation (e.g. for tests or non-browser runtimes). */
  fetch?: typeof fetch;
  /** Forwarded to the underlying request (headers, signal, credentials, ...). */
  init?: RequestInit;
};

/**
 * Error thrown by {@link request} for any non-2xx hub response. Carries the HTTP
 * `status` alongside the hub's human message so callers (e.g. the Insights UI)
 * can branch a permission denial (403) from a transient failure (5xx/network)
 * without parsing the message string. Subclasses `Error`, so existing catch
 * sites that only read `.message` are unaffected.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** True when `error` is an {@link HttpError} carrying HTTP 403 (permission denied). */
export function isForbiddenError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 403;
}

const API_PREFIX = "api/v1";
// Tenant-scoped insight routes (actor search, per-principal activity) mount
// under `/api/tenants/:tenantId/...` behind Interchange's resolveTenant — not
// under the `/api/v1` prefix the rest of the client uses.
const TENANT_API_PREFIX = "api";

function resolveUrl(
  path: string,
  baseUrl?: string,
  apiPrefix: string = API_PREFIX,
): string {
  const cleanPath = path.replace(/^\//, "");
  const origin =
    baseUrl ??
    (typeof globalThis.location !== "undefined"
      ? globalThis.location.origin
      : undefined);
  if (!origin) {
    throw new Error(
      "Cannot resolve request URL: no baseUrl provided and no global location available.",
    );
  }
  return new URL(`/${apiPrefix}/${cleanPath}`, origin).toString();
}

async function request<T>(
  path: string,
  options: ClientOptions,
  apiPrefix: string = API_PREFIX,
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const url = resolveUrl(path, options.baseUrl, apiPrefix);
  const init: RequestInit = {
    method: "GET",
    credentials: "include",
    ...options.init,
  };

  const res = await doFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new HttpError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const TenantMemberSchema = type({ id: "string", name: "string" });
const MembersResponseSchema = type({ members: TenantMemberSchema.array() });

export type TenantMember = typeof TenantMemberSchema.infer;

export const ListMembersParamsSchema = type({
  "tenantId?": "string | null",
});
export type ListMembersParams = typeof ListMembersParamsSchema.infer;

/** Fetch user principals for a tenant (`GET /members`). */
export async function listMembers(
  options: ClientOptions = {},
  params: ListMembersParams = {},
): Promise<TenantMember[]> {
  const search = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const raw = await request<unknown>(`members${search}`, options);
  const parsed = MembersResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /members response: ${parsed.summary}`);
  }
  return parsed.members;
}

export const ListWorkflowsParamsSchema = type({
  "tenantId?": "string | null",
});
export type ListWorkflowsParams = typeof ListWorkflowsParamsSchema.infer;

export const ListArtifactsParamsSchema = type({
  "tenantId?": "string | null",
  "query?": "string",
  "sort?": "'newest' | 'oldest'",
  "kind?": "string",
  "status?": "'draft' | 'approved' | 'rejected'",
  "ownerPrincipalId?": "string",
  "creatorKind?": "'user' | 'agent'",
  /** Date-only `yyyy-mm-dd` or ISO timestamp; only artifacts created at/after this are returned. */
  "createdAfter?": "string",
  /** Date-only `yyyy-mm-dd` upper bound (inclusive end-of-day) or ISO timestamp. */
  "createdBefore?": "string",
  "cursor?": "string",
  "limit?": "number",
});
export type ListArtifactsParams = typeof ListArtifactsParamsSchema.infer;

/**
 * `ArtifactWithSession` is a derived plain type in `@workbench/shared`; this
 * composes its exported `Artifact` schema with the session-enrichment fields
 * so the `GET /artifacts` page can be parsed at the boundary. The conformance
 * assertion below fails the build if this schema drifts from the shared type.
 */
export const ArtifactWithSessionSchema = Artifact.and({
  sessionName: "string | null",
  sessionStatus: SessionStatusSchema.or("null"),
  ownerName: "string | null",
});

type AssertExtends<A extends B, B> = A;
// Compile-time guard: the parsed page rows must remain assignable to the
// shared `ArtifactWithSession`, so a schema drift fails the build.
export type ArtifactWithSessionParsed = AssertExtends<
  typeof ArtifactWithSessionSchema.infer,
  ArtifactWithSession
>;

export const ArtifactsPageSchema = type({
  artifacts: ArtifactWithSessionSchema.array(),
  nextCursor: "string | null",
});
export type ArtifactsPage = typeof ArtifactsPageSchema.infer;

export const GetArtifactParamsSchema = type({
  "tenantId?": "string | null",
});
export type GetArtifactParams = typeof GetArtifactParamsSchema.infer;

export const GetArtifactResponseSchema = type({
  artifact: ArtifactWithSessionSchema,
});

export const CreateArtifactParamsSchema = type({
  "tenantId?": "string | null",
  /** `url` links an external page (content is the URL); `text` stores a pasted body. */
  mode: "'url' | 'text'",
  title: "string",
  content: "string",
  "kind?": "string",
  "generatedBy?": "string",
});
export type CreateArtifactParams = typeof CreateArtifactParamsSchema.infer;

/**
 * Serializable subset of {@link UploadArtifactsParams}. `files` is a
 * `File[]` (non-serializable blobs) and cannot be expressed in arktype, so it
 * is intersected as a plain type below.
 */
export const UploadArtifactsParamsSchema = type({
  "tenantId?": "string | null",
  /** Optional attribution label stamped on every created artifact. */
  "generatedBy?": "string",
});
export type UploadArtifactsParams = typeof UploadArtifactsParamsSchema.infer & {
  /** Files to import; one artifact is created per file. */
  files: File[];
};

const WorkflowRunRowSchema = type({
  deploymentId: "string",
  kind: "string",
  status: "string",
  createdAt: "string",
});
const WorkflowRunsResponseSchema = WorkflowRunRowSchema.array();

/**
 * Fetch the tenant's natively-deployed workflows (`GET /workflow-runs`).
 * `tenantId` MUST be forwarded: the route resolves visibility against the
 * requested workbench (walking its ancestor chain to the global tenant). With
 * it omitted the hub falls back to the caller's default context, whose chain
 * does not include a child workbench, so an active-workbench deployment is
 * invisible and the library rail shows nothing.
 */
export async function listWorkflows(
  options: ClientOptions = {},
  params: ListWorkflowsParams = {},
): Promise<WorkflowSummary[]> {
  const search = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const raw = await request<unknown>(`workflow-runs${search}`, options);
  const parsed = WorkflowRunsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /workflow-runs response: ${parsed.summary}`);
  }
  return parsed.map((row) => ({
    id: row.deploymentId,
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt,
  }));
}

export const SkillItemSchema = type({
  id: "string",
  name: "string",
  displayName: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type SkillItem = typeof SkillItemSchema.infer;

export const ListSkillsParamsSchema = type({
  "tenantId?": "string | null",
});
export type ListSkillsParams = typeof ListSkillsParamsSchema.infer;

export const CreateSkillParamsSchema = type({
  "tenantId?": "string | null",
  name: "string",
  "description?": "string | null",
  text: "string",
});
export type CreateSkillParams = typeof CreateSkillParamsSchema.infer;

export const UpdateSkillParamsSchema = type({
  "tenantId?": "string | null",
  assetId: "string",
  "description?": "string | null",
  text: "string",
});
export type UpdateSkillParams = typeof UpdateSkillParamsSchema.infer;

export const AttachSkillParamsSchema = type({
  "tenantId?": "string | null",
  agentId: "string",
  assetId: "string",
});
export type AttachSkillParams = typeof AttachSkillParamsSchema.infer;

export const DetachSkillParamsSchema = type({
  "tenantId?": "string | null",
  agentId: "string",
  assetId: "string",
});
export type DetachSkillParams = typeof DetachSkillParamsSchema.infer;

const SkillsResponseSchema = type({ skills: SkillItemSchema.array() });
const SkillResponseSchema = type({ skill: SkillItemSchema });

export async function listSkills(
  options: ClientOptions = {},
  params: ListSkillsParams = {},
): Promise<SkillItem[]> {
  const search = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const raw = await request<unknown>(`skills${search}`, options);
  const parsed = SkillsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /skills response: ${parsed.summary}`);
  }
  return parsed.skills;
}

export async function createSkill(
  options: ClientOptions = {},
  params: CreateSkillParams,
): Promise<SkillItem> {
  const qs = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const raw = await request<unknown>(`skills${qs}`, {
    ...options,
    init: {
      ...options.init,
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        description: params.description,
        text: params.text,
      }),
      headers: { "Content-Type": "application/json", ...options.init?.headers },
    },
  });
  const parsed = SkillResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /skills response: ${parsed.summary}`);
  }
  return parsed.skill;
}

export async function updateSkill(
  options: ClientOptions = {},
  params: UpdateSkillParams,
): Promise<SkillItem> {
  const qs = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const raw = await request<unknown>(`skills${qs}`, {
    ...options,
    init: {
      ...options.init,
      method: "POST",
      body: JSON.stringify({
        assetId: params.assetId,
        description: params.description,
        text: params.text,
      }),
      headers: { "Content-Type": "application/json", ...options.init?.headers },
    },
  });
  const parsed = SkillResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /skills response: ${parsed.summary}`);
  }
  return parsed.skill;
}

export async function attachSkill(
  options: ClientOptions = {},
  params: AttachSkillParams,
): Promise<void> {
  const qs = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  await request<unknown>(
    `agents/${params.agentId}/skills/${params.assetId}${qs}`,
    {
      ...options,
      init: { ...options.init, method: "POST" },
    },
  );
}

export async function detachSkill(
  options: ClientOptions = {},
  params: DetachSkillParams,
): Promise<void> {
  const qs = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  await request<unknown>(
    `agents/${params.agentId}/skills/${params.assetId}${qs}`,
    {
      ...options,
      init: { ...options.init, method: "DELETE" },
    },
  );
}

/**
 * Fetch the current user's artifacts across all their jobs, each enriched
 * with the originating job (`GET /artifacts`).
 */
export async function listArtifacts(
  options: ClientOptions = {},
  params: ListArtifactsParams = {},
): Promise<ArtifactsPage> {
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set("tenantId", params.tenantId);
  if (params.query) qs.set("query", params.query);
  if (params.sort) qs.set("sort", params.sort);
  if (params.kind) qs.set("kind", params.kind);
  if (params.status) qs.set("status", params.status);
  if (params.ownerPrincipalId)
    qs.set("ownerPrincipalId", params.ownerPrincipalId);
  if (params.creatorKind) qs.set("creatorKind", params.creatorKind);
  if (params.createdAfter) qs.set("createdAfter", params.createdAfter);
  if (params.createdBefore) qs.set("createdBefore", params.createdBefore);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const search = qs.size > 0 ? `?${qs.toString()}` : "";
  const raw = await request<unknown>(`artifacts${search}`, options);
  const parsed = ArtifactsPageSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /artifacts response: ${parsed.summary}`);
  }
  return parsed;
}

/** Fetch one tenant-scoped artifact by id (`GET /artifacts/:id`). */
export async function getArtifact(
  options: ClientOptions = {},
  artifactId: string,
  params: GetArtifactParams = {},
): Promise<ArtifactWithSession> {
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set("tenantId", params.tenantId);
  const search = qs.size > 0 ? `?${qs.toString()}` : "";
  const raw = await request<unknown>(
    `artifacts/${encodeURIComponent(artifactId)}${search}`,
    options,
  );
  const parsed = GetArtifactResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid GET /artifacts/:id response: ${parsed.summary}`);
  }
  return parsed.artifact;
}

const CreateArtifactResponseSchema = type({ artifact: Artifact });

/**
 * Create an artifact from an external source (`POST /artifacts`). Used by the
 * gallery's "Add from source" flow to link a URL or store pasted text. The hub
 * stamps the required provenance origin (`imported` / `manual`).
 */
export async function createArtifact(
  options: ClientOptions = {},
  params: CreateArtifactParams,
): Promise<Artifact> {
  const qs = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const raw = await request<unknown>(`artifacts${qs}`, {
    ...options,
    init: {
      ...options.init,
      method: "POST",
      body: JSON.stringify({
        mode: params.mode,
        title: params.title,
        content: params.content,
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.generatedBy ? { generatedBy: params.generatedBy } : {}),
      }),
      headers: { "Content-Type": "application/json", ...options.init?.headers },
    },
  });
  const parsed = CreateArtifactResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid POST /artifacts response: ${parsed.summary}`);
  }
  return parsed.artifact;
}

const UploadArtifactsResponseSchema = type({ artifacts: Artifact.array() });

/**
 * Import one or more files as artifacts (`POST /artifacts/upload`). Sends
 * multipart/form-data (browser `FormData`); the hub persists each file's binary
 * and stamps an `imported` origin. Returns one artifact per uploaded file.
 */
export async function uploadArtifacts(
  options: ClientOptions = {},
  params: UploadArtifactsParams,
): Promise<Artifact[]> {
  const qs = params.tenantId
    ? `?tenantId=${encodeURIComponent(params.tenantId)}`
    : "";
  const form = new FormData();
  for (const file of params.files) {
    form.append("files", file, file.name);
  }
  if (params.generatedBy) form.append("generatedBy", params.generatedBy);

  const raw = await request<unknown>(`artifacts/upload${qs}`, {
    ...options,
    init: {
      ...options.init,
      method: "POST",
      body: form,
    },
  });
  const parsed = UploadArtifactsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Invalid POST /artifacts/upload response: ${parsed.summary}`,
    );
  }
  return parsed.artifacts;
}

// ─── Actor search + per-principal activity (Insights) ───────────────

export const ActorSchema = type({
  id: "string",
  kind: "'user' | 'agent'",
  displayName: "string",
  "email?": "string",
  /** Lifecycle status (e.g. `active`, `deactivated`); non-active actors remain findable. */
  status: "string",
});
export type Actor = typeof ActorSchema.infer;

export const ActorSearchResponseSchema = type({ actors: ActorSchema.array() });
export type ActorSearchResponse = typeof ActorSearchResponseSchema.infer;

export const SearchActorsParamsSchema = type({
  tenantId: "string",
  /** Free-text query; the hub requires at least 2 characters. */
  query: "string",
  "limit?": "number",
});
export type SearchActorsParams = typeof SearchActorsParamsSchema.infer;

/**
 * Search user and agent principals in a tenant
 * (`GET /api/tenants/:tenantId/actors/search`). Callers must debounce
 * (>= 300ms) and gate on a 2+ character query.
 */
export async function searchActors(
  options: ClientOptions = {},
  params: SearchActorsParams,
): Promise<Actor[]> {
  // The hub route reads `q`, not `query` (apps/hub/src/routes/actor-search.ts).
  const qs = new URLSearchParams({ q: params.query });
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/actors/search?${qs.toString()}`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = ActorSearchResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /actors/search response: ${parsed.summary}`);
  }
  return parsed.actors;
}

export const GetActorParamsSchema = type({
  tenantId: "string",
  principalId: "string",
});
export type GetActorParams = typeof GetActorParamsSchema.infer;

/**
 * Resolve a single principal's actor identity
 * (`GET /api/tenants/:tenantId/actors/:principalId`). Returns `null` when the
 * principal does not exist in the tenant (hub 404), so the deep-linkable actor
 * page can distinguish "unknown actor" from a transport error.
 */
export async function getActor(
  options: ClientOptions = {},
  params: GetActorParams,
): Promise<Actor | null> {
  const doFetch = options.fetch ?? fetch;
  const url = resolveUrl(
    `tenants/${encodeURIComponent(params.tenantId)}/actors/${encodeURIComponent(params.principalId)}`,
    options.baseUrl,
    TENANT_API_PREFIX,
  );
  const res = await doFetch(url, {
    method: "GET",
    credentials: "include",
    ...options.init,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    // The hub returns `{ error: { code, message } }` (an object). Reach into
    // `.message` so a 500 surfaces the human string, not `[object Object]`.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string } | string;
    };
    const message =
      typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message ?? `HTTP ${res.status}`);
  }
  const raw = (await res.json()) as unknown;
  const parsed = ActorSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /actors/:id response: ${parsed.summary}`);
  }
  return parsed;
}

// ─── Cache-baseline cost rollup (Insights cost view, CL-2687) ────────

/**
 * Per-agent prompt-caching + token rollup over the raw `inference_done` facts
 * (hub `getCacheBaseline`, CL-2686). Carries the full cache split — input,
 * output, cache-read, cache-write — plus the derived miss/absorption ratios the
 * cost view reads. `agentName` is null for an orphaned/renamed agent.
 */
export const CacheBaselineRowSchema = type({
  agentId: "string",
  agentName: "string | null",
  inferenceCalls: "number",
  cacheMissCalls: "number",
  cacheHitCalls: "number",
  sessionCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  cacheMissRate: "number",
  cacheAbsorptionRatio: "number",
});
export type CacheBaselineRow = typeof CacheBaselineRowSchema.infer;

export const CacheBaselineResponseSchema = type({
  tenantId: "string",
  agents: CacheBaselineRowSchema.array(),
});
export type CacheBaselineResponse = typeof CacheBaselineResponseSchema.infer;

export const GetCacheBaselineParamsSchema = type({
  tenantId: "string",
  /** Inclusive `yyyy-mm-dd` lower bound on `occurred_at`. */
  "startDate?": "string",
  /** Inclusive `yyyy-mm-dd` upper bound (end-of-day). */
  "endDate?": "string",
  /** Scope to a single agent definition. */
  "agentId?": "string",
  /** Scope to a single agent instance. */
  "instanceId?": "string",
});
export type GetCacheBaselineParams = typeof GetCacheBaselineParamsSchema.infer;

/**
 * Fetch the per-agent cache/token baseline
 * (`GET /api/tenants/:tenantId/analytics/cache-baseline`). Rows are sorted by
 * inference-call count descending by the hub. Powers the Insights cost view's
 * per-agent rollup and cache-read/write/output split.
 */
export async function getCacheBaseline(
  options: ClientOptions = {},
  params: GetCacheBaselineParams,
): Promise<CacheBaselineRow[]> {
  const qs = new URLSearchParams();
  if (params.startDate !== undefined) qs.set("startDate", params.startDate);
  if (params.endDate !== undefined) qs.set("endDate", params.endDate);
  if (params.agentId !== undefined) qs.set("agentId", params.agentId);
  if (params.instanceId !== undefined) qs.set("instanceId", params.instanceId);
  const search = qs.size > 0 ? `?${qs.toString()}` : "";
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/analytics/cache-baseline${search}`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = CacheBaselineResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /cache-baseline response: ${parsed.summary}`);
  }
  return parsed.agents;
}

export const ActivityPageSchema = type({
  entries: TimelineEntrySchema.array(),
  nextCursor: "string | null",
});
export type ActivityPage = typeof ActivityPageSchema.infer;

export const GetPrincipalActivityParamsSchema = type({
  tenantId: "string",
  principalId: "string",
  /** Page size, 1-100 (hub default 50). */
  "limit?": "number",
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  "cursor?": "string",
});
export type GetPrincipalActivityParams =
  typeof GetPrincipalActivityParamsSchema.infer;

/**
 * Fetch one page of a principal's activity timeline, newest first
 * (`GET /api/tenants/:tenantId/principals/:principalId/activity`). Entries are
 * the kind-discriminated union from `@workbench/timeline`.
 */
export async function getPrincipalActivity(
  options: ClientOptions = {},
  params: GetPrincipalActivityParams,
): Promise<ActivityPage> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor !== undefined) qs.set("cursor", params.cursor);
  const search = qs.size > 0 ? `?${qs.toString()}` : "";
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/principals/${encodeURIComponent(params.principalId)}/activity${search}`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = ActivityPageSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /activity response: ${parsed.summary}`);
  }
  return parsed;
}

export const GetTenantActivityParamsSchema = type({
  tenantId: "string",
  /** Page size, 1-100 (hub default 50). */
  "limit?": "number",
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  "cursor?": "string",
});
export type GetTenantActivityParams =
  typeof GetTenantActivityParamsSchema.infer;

/**
 * Fetch one page of the TENANT-WIDE activity timeline, newest first
 * (`GET /api/tenants/:tenantId/activity/timeline`). This is the default
 * Insights feed (CL-2743): activity merged across every principal in the
 * tenant. Gated by tenant membership only; cross-tenant rows never resolve.
 */
export async function getTenantActivity(
  options: ClientOptions = {},
  params: GetTenantActivityParams,
): Promise<ActivityPage> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor !== undefined) qs.set("cursor", params.cursor);
  const search = qs.size > 0 ? `?${qs.toString()}` : "";
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/activity/timeline${search}`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = ActivityPageSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /activity/timeline response: ${parsed.summary}`);
  }
  return parsed;
}

// ─── Principal roster (Agents & workflows facet, CL-2737) ────────────

export const RosterInstanceSchema = type({
  instanceId: "string",
  principalId: "string",
  name: "string",
  status: "string",
  sessionCount: "number",
});
export type RosterInstance = typeof RosterInstanceSchema.infer;

export const RosterRunSchema = type({
  runId: "string",
  kind: "string",
  status: "string",
});
export type RosterRun = typeof RosterRunSchema.infer;

export const PrincipalRosterSchema = type({
  instances: RosterInstanceSchema.array(),
  runs: RosterRunSchema.array(),
});
export type PrincipalRoster = typeof PrincipalRosterSchema.infer;

export const GetPrincipalRosterParamsSchema = type({
  tenantId: "string",
  principalId: "string",
});
export type GetPrincipalRosterParams =
  typeof GetPrincipalRosterParamsSchema.infer;

/**
 * Fetch a principal's owned agent instances and workflow runs
 * (`GET /api/tenants/:tenantId/principals/:principalId/roster`). Powers the
 * principal trace's "Agents & workflows" facet: each instance/run deep-links to
 * its own trace surface.
 */
export async function getPrincipalRoster(
  options: ClientOptions = {},
  params: GetPrincipalRosterParams,
): Promise<PrincipalRoster> {
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/principals/${encodeURIComponent(params.principalId)}/roster`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = PrincipalRosterSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /roster response: ${parsed.summary}`);
  }
  return parsed;
}

// ─── Principal analytics (Insights Tools + Cost facets) ──

export const PrincipalToolRowSchema = type({
  name: "string",
  calls: "number",
  errors: "number",
});
export type PrincipalToolRow = typeof PrincipalToolRowSchema.infer;

export const PrincipalCostSummarySchema = type({
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
  inferenceCalls: "number",
  toolCalls: "number",
});
export type PrincipalCostSummary = typeof PrincipalCostSummarySchema.infer;

export const PrincipalAnalyticsSchema = type({
  tools: PrincipalToolRowSchema.array(),
  cost: PrincipalCostSummarySchema,
});
export type PrincipalAnalytics = typeof PrincipalAnalyticsSchema.infer;

export const GetPrincipalAnalyticsParamsSchema = type({
  tenantId: "string",
  principalId: "string",
});
export type GetPrincipalAnalyticsParams =
  typeof GetPrincipalAnalyticsParamsSchema.infer;

/**
 * Fetch a principal's tool-call breakdown and token/cost totals
 * (`GET /api/tenants/:tenantId/principals/:principalId/analytics`). Powers the
 * principal trace's Tools and Cost facets, aggregated from the durable
 * analytics_event fact table (not the loaded timeline window).
 */
export async function getPrincipalAnalytics(
  options: ClientOptions = {},
  params: GetPrincipalAnalyticsParams,
): Promise<PrincipalAnalytics> {
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/principals/${encodeURIComponent(params.principalId)}/analytics`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = PrincipalAnalyticsSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /analytics response: ${parsed.summary}`);
  }
  return parsed;
}

// ─── Tenant roster (dashboard-level clickable Agents + runs, CL-2798) ──

export const TenantRosterSchema = type({
  instances: RosterInstanceSchema.array(),
  runs: RosterRunSchema.array(),
});
export type TenantRoster = typeof TenantRosterSchema.infer;

export const GetTenantRosterParamsSchema = type({
  tenantId: "string",
});
export type GetTenantRosterParams = typeof GetTenantRosterParamsSchema.infer;

/**
 * Fetch a tenant's agent instances and most recent workflow runs
 * (`GET /api/tenants/:tenantId/roster`). Powers the Insights dashboard's
 * first-class, clickable Agents and Recent-runs surfaces: each instance
 * deep-links to its trace (`/insights/users/:principalId`) and each run to its
 * execution trace (`/insights/trace/:runId`).
 */
export async function getTenantRoster(
  options: ClientOptions = {},
  params: GetTenantRosterParams,
): Promise<TenantRoster> {
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/roster`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = TenantRosterSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /roster response: ${parsed.summary}`);
  }
  return parsed;
}

export const GetMomentDetailParamsSchema = type({
  tenantId: "string",
  principalId: "string",
  kind: "string",
  id: "string",
});
export type GetMomentDetailParams = typeof GetMomentDetailParamsSchema.infer;

/**
 * Expand one opened activity moment into its rich detail
 * (`GET /api/tenants/:tenantId/principals/:principalId/activity/:kind/:id/detail`).
 * The paginated timeline stays lean; this fires only when a moment is opened.
 */
export async function getMomentDetail(
  options: ClientOptions = {},
  params: GetMomentDetailParams,
): Promise<MomentDetail> {
  const raw = await request<unknown>(
    `tenants/${encodeURIComponent(params.tenantId)}/principals/${encodeURIComponent(params.principalId)}/activity/${encodeURIComponent(params.kind)}/${encodeURIComponent(params.id)}/detail`,
    options,
    TENANT_API_PREFIX,
  );
  const parsed = MomentDetailSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid moment detail response: ${parsed.summary}`);
  }
  return parsed;
}
