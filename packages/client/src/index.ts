// @workbench/client — framework-agnostic data-access seam for the workbench hub.
//
// These functions are the reusable boundary: any app or demo can point them at
// its own hub by passing a `baseUrl` and/or a custom `fetch`. They return clean
// `@workbench/shared` domain types and contain no presentation logic.

import { type } from "arktype";
import { Artifact, SessionStatusSchema } from "@workbench/shared";
import type { ArtifactWithSession, WorkflowSummary } from "@workbench/shared";

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

const API_PREFIX = "api/v1";

function resolveUrl(path: string, baseUrl?: string): string {
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
  return new URL(`/${API_PREFIX}/${cleanPath}`, origin).toString();
}

async function request<T>(path: string, options: ClientOptions): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const url = resolveUrl(path, options.baseUrl);
  const init: RequestInit = {
    method: "GET",
    credentials: "include",
    ...options.init,
  };

  const res = await doFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
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
