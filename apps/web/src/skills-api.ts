// Skills are native `kind:"skill"` hub assets, listed via the stock asset
// routes. Those carry only metadata, so `description` always reads back
// empty and there is no update/scope/version-history route yet.
import { type } from "arktype";

import { ApiQueryError } from "@/lib/api-query";
import { apiRequest, type Validator } from "./api";

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

function base(tenantId: string): string {
  return `/api/tenants/${tenantId}/assets`;
}

function request<T>(
  path: string,
  schema: Validator<T>,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return apiRequest(
    path,
    schema,
    undefined,
    ApiQueryError,
    init.body === undefined
      ? { method: init.method ?? "GET" }
      : {
          method: init.method ?? "GET",
          body: JSON.stringify(init.body),
        },
  );
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

// Creates metadata only — no stock route yet populates SKILL.md content
// in the same call.
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
