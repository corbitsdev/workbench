// The Skills settings section's one seam to the hub's skill registry
// (`@corbits/skills`, mounted at `/api/tenants/:tenantId/skills`).
// Tenant-scoped like `./agents-api.ts`, and validated at the boundary
// with arktype so a shape change surfaces as an error state rather than
// as undefined leaking into the page.
//
// This replaced the session-local skill store CL-5991 shipped: there is
// exactly one registry now, and creating a skill writes it directly —
// there is no pending draft stage.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

import { ApiQueryError } from "@corbits/api-query";

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

const SkillListResponse = type({ skills: SkillSummary.array() });
const SkillDetailResponse = type({
  skill: SkillDetail,
  pinnedBy: PinnedByEntry.array(),
});
const SkillVersionsResponse = type({ versions: SkillVersion.array() });
const SkillResponse = type({ skill: SkillSummary });

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
    response =
      init.body === undefined
        ? await fetch(path, {
            method: init.method ?? "GET",
            headers: { accept: "application/json" },
          })
        : await fetch(path, {
            method: init.method ?? "GET",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify(init.body),
          });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = ErrorEnvelope(json);
    throw new ApiQueryError(
      envelope instanceof type.errors
        ? `The server answered ${String(response.status)} for ${path}.`
        : envelope.error.message,
      response.status,
    );
  }
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
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

const DEFAULT_CREATE_SCOPE: SkillScope = "private";

/**
 * Creates a skill directly as a native `kind:"skill"` asset — no pending
 * draft stage. New skills start private; sharing is the separate
 * `setSkillScope` toggle below.
 */
export function createSkill(
  tenantId: string,
  input: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
  },
): Promise<SkillSummary> {
  return request(base(tenantId), SkillResponse, {
    method: "POST",
    body: {
      name: input.name,
      description: input.description,
      body: input.body,
      scope: DEFAULT_CREATE_SCOPE,
    },
  }).then((page) => page.skill);
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
 * Sharing a skill exposes it to the whole workbench; making it private
 * again pulls it back to its author alone. Both are the same one-field
 * write, so they share a call rather than two endpoints that could drift.
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
