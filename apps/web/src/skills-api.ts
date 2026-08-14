// The Skills settings section's one seam to the hub's skill registry
// (`@corbits/skills`, mounted at `/api/tenants/:tenantId/skills`).
// Tenant-scoped like `./agents-api.ts`, and validated at the boundary
// with arktype so a shape change surfaces as an error state rather than
// as undefined leaking into the page.
//
// This replaced the session-local skill store CL-5991 shipped: there is
// exactly one registry now, and a "draft" is a pending row on it rather
// than something that lives only in a browser tab.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

export class SkillsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SkillsApiError";
  }
}

export const SkillScope = type("'private' | 'tenant'");
export type SkillScope = typeof SkillScope.infer;

const SkillSummary = type({
  assetId: "string",
  name: "string",
  description: "string",
  scope: SkillScope,
  creatorPrincipalId: "string",
  updatedAtIso: "string",
});
export type SkillSummary = typeof SkillSummary.infer;

const SkillDetail = SkillSummary.merge(type({ body: "string" }));
export type SkillDetail = typeof SkillDetail.infer;

const PinnedByEntry = type({ definitionId: "string", name: "string" });
export type PinnedByEntry = typeof PinnedByEntry.infer;

const SkillVersion = type({
  commitSha: "string",
  message: "string",
  author: "string",
  committedAtIso: "string",
  current: "boolean",
});
export type SkillVersion = typeof SkillVersion.infer;

const SkillDraft = type({
  assetId: "string",
  name: "string",
  description: "string",
  updatedAtIso: "string",
});
export type SkillDraft = typeof SkillDraft.infer;

const SkillListResponse = type({ skills: SkillSummary.array() });
const SkillDraftListResponse = type({ drafts: SkillDraft.array() });
const SkillDetailResponse = type({
  skill: SkillDetail,
  pinnedBy: PinnedByEntry.array(),
});
const SkillVersionsResponse = type({ versions: SkillVersion.array() });
const SkillResponse = type({ skill: SkillSummary });
const SkillDraftResponse = type({ draft: SkillDraft });

const ErrorEnvelope = type({ error: { message: "string" } });

type Validator<T> = (data: unknown) => T | ArkErrors;

function base(tenantId: string): string {
  return `/api/tenants/${tenantId}/skills`;
}

async function request<T>(
  path: string,
  schema: Validator<T>,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (cause) {
    throw new SkillsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = ErrorEnvelope(json);
    throw new SkillsApiError(
      envelope instanceof type.errors
        ? `The server answered ${String(response.status)} for ${path}.`
        : envelope.error.message,
      response.status,
    );
  }
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new SkillsApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function listSkills(
  tenantId: string,
  query = "",
): Promise<readonly SkillSummary[]> {
  const suffix = query.trim() === "" ? "" : `?q=${encodeURIComponent(query)}`;
  return request(`${base(tenantId)}${suffix}`, SkillListResponse).then(
    (page) => page.skills,
  );
}

export function listSkillDrafts(
  tenantId: string,
): Promise<readonly SkillDraft[]> {
  return request(`${base(tenantId)}/drafts`, SkillDraftListResponse).then(
    (page) => page.drafts,
  );
}

export function loadSkill(
  tenantId: string,
  name: string,
): Promise<{
  readonly skill: SkillDetail;
  readonly pinnedBy: readonly PinnedByEntry[];
}> {
  return request(
    `${base(tenantId)}/${encodeURIComponent(name)}`,
    SkillDetailResponse,
  );
}

export function listSkillVersions(
  tenantId: string,
  name: string,
): Promise<readonly SkillVersion[]> {
  return request(
    `${base(tenantId)}/${encodeURIComponent(name)}/versions`,
    SkillVersionsResponse,
  ).then((page) => page.versions);
}

export function createSkillDraft(
  tenantId: string,
  input: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
  },
): Promise<SkillDraft> {
  return request(`${base(tenantId)}/drafts`, SkillDraftResponse, {
    method: "POST",
    body: input,
  }).then((page) => page.draft);
}

export function publishSkillDraft(
  tenantId: string,
  name: string,
  scope: SkillScope,
): Promise<SkillSummary> {
  return request(
    `${base(tenantId)}/drafts/${encodeURIComponent(name)}/publish`,
    SkillResponse,
    { method: "POST", body: { scope } },
  ).then((page) => page.skill);
}

export function restoreSkillVersion(
  tenantId: string,
  name: string,
  commitSha: string,
): Promise<SkillSummary> {
  return request(
    `${base(tenantId)}/${encodeURIComponent(name)}/restore`,
    SkillResponse,
    { method: "POST", body: { commitSha } },
  ).then((page) => page.skill);
}

/**
 * Installing a skill shares it with the whole workbench; uninstalling
 * pulls it back to its author. Both are the same one-field write, so
 * they share a call rather than two endpoints that could drift.
 */
export function setSkillScope(
  tenantId: string,
  name: string,
  scope: SkillScope,
): Promise<SkillSummary> {
  return request(
    `${base(tenantId)}/${encodeURIComponent(name)}/scope`,
    SkillResponse,
    { method: "PUT", body: { scope } },
  ).then((page) => page.skill);
}
