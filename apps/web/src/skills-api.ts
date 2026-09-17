// The Skills settings section's one seam to the hub's skill assets.
//
// CL-8086: the workbench-specific skill registry this used to call
// (`@corbits/skills`, mounted at `/api/tenants/:tenantId/skills`) was
// deleted — skills are native `kind:"skill"` hub assets now, listed and
// created through the stock asset routes (`@intx/hub-api`'s
// `routes/assets.ts`). Those routes carry only asset metadata (id, name,
// displayName, creator, timestamps): there is no stock route yet to
// read or write a skill's SKILL.md content (description/body), its
// version history, its scope, or who has it pinned. `description` below
// always reads back empty and `updateSkill`/`setSkillScope`/version
// history are gone outright rather than vendored over a route that
// doesn't exist — see the CL-8086 PR body for this gap.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

import { ApiQueryError } from "@corbits/api-query";

const SkillSummary = type({
  assetId: "string",
  name: "string",
  displayName: "string | null",
  description: "string",
  creatorPrincipalId: "string | null",
  updatedAtIso: "string",
});
export type SkillSummary = typeof SkillSummary.infer;

const AssetResponse = type({
  id: "string",
  tenantId: "string",
  kind: "string",
  name: "string",
  displayName: "string | null",
  creatorPrincipalId: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
type Asset = typeof AssetResponse.infer;

const AssetListResponse = AssetResponse.array();

const ErrorEnvelope = type({
  error: { code: "string", message: "string" },
});

type Validator<T> = (data: unknown) => T | ArkErrors;

function base(tenantId: string): string {
  return `/api/tenants/${tenantId}/assets`;
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
      undefined,
      path,
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = ErrorEnvelope(json);
    throw new ApiQueryError(
      envelope instanceof type.errors
        ? `The server answered ${String(response.status)}.`
        : envelope.error.message,
      response.status,
      path,
    );
  }
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

function toSkillSummary(asset: Asset): SkillSummary {
  return {
    assetId: asset.id,
    name: asset.name,
    displayName: asset.displayName,
    // No stock route yet serves a skill's SKILL.md content — see the
    // module comment above.
    description: "",
    creatorPrincipalId: asset.creatorPrincipalId,
    updatedAtIso: asset.updatedAt,
  };
}

export function listSkills(tenantId: string, query = ""): Promise<readonly SkillSummary[]> {
  return request(`${base(tenantId)}?kind=skill&inherited=false`, AssetListResponse).then(
    (assets) => {
      const skills = assets.map(toSkillSummary);
      const needle = query.trim().toLowerCase();
      return needle === ""
        ? skills
        : skills.filter((skill) => skill.name.toLowerCase().includes(needle));
    },
  );
}

export async function loadSkill(
  tenantId: string,
  name: string,
): Promise<{ readonly skill: SkillSummary }> {
  const skills = await listSkills(tenantId);
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill === undefined) {
    throw new ApiQueryError(`No skill named "${name}" in this workbench.`, 404, base(tenantId));
  }
  return { skill };
}

/**
 * Creates a skill asset's metadata only — a bare `kind:"skill"` asset
 * row and its (empty) backing repo. There is no stock route yet to
 * populate its SKILL.md body/description in the same call (CL-8086);
 * the caller must fill those in through whatever surface eventually
 * covers skill content.
 */
export function createSkill(
  tenantId: string,
  input: { readonly name: string; readonly displayName?: string },
): Promise<SkillSummary> {
  return request(base(tenantId), AssetResponse, {
    method: "POST",
    body: {
      kind: "skill",
      name: input.name,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    },
  }).then(toSkillSummary);
}
