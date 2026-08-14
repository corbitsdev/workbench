// The skill registry. One surface, one store: every skill — draft or
// published — is a native `kind:"skill"` hub asset carrying a single
// `<name>/SKILL.md`, and every version of it is a commit on that asset's
// default ref.
//
// Drafts. The hub's asset kinds are a closed set
// (`vendor/intx/hub-api/src/routes/assets.ts`'s `KIND_VALUES`:
// agent-state, skill, package-registry, workflow) and vendored code is
// never edited here, so there is no `skill-draft` kind to create. A
// draft is instead a real `kind:"skill"` asset whose asset name carries
// the `draft-` prefix, and its existence IS the pending state: a
// prefixed asset never appears in `list`/`search`/`load`, and it carries
// no `skill_access` row at all, so nothing can read it but its own
// author's draft surface. Publishing creates the canonical asset,
// commits the draft's SKILL.md into it, writes the access row, and only
// then drops the draft asset — so a crash mid-publish leaves the draft
// standing (still pending, retryable) rather than a half-published skill.
// The `draft-` prefix is therefore reserved: a skill may not be named
// into it.
import {
  canAdministerSkill,
  isSkillVisibleTo,
  skillAccessScopeSchema,
  type SkillAccessRow,
  type SkillAccessScope,
  type SkillAccessStore,
  type SkillCaller,
} from "./access";
import type { SkillAssetStore, SkillCommit } from "./asset-store";
import {
  buildSkillMd,
  parseSkillMd,
  skillNameSchema,
  SkillContentError,
} from "./skill-md";
import { type } from "arktype";

export const DRAFT_ASSET_NAME_PREFIX = "draft-";

export type SkillRegistryErrorReason =
  "not_found" | "forbidden" | "conflict" | "invalid";

export class SkillRegistryError extends Error {
  readonly reason: SkillRegistryErrorReason;
  constructor(reason: SkillRegistryErrorReason, message: string) {
    super(message);
    this.name = "SkillRegistryError";
    this.reason = reason;
  }
}

export type SkillSummary = {
  readonly assetId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: SkillAccessScope;
  readonly creatorPrincipalId: string;
  readonly updatedAtIso: string;
};

export type SkillDetail = SkillSummary & { readonly body: string };

export type SkillDraftSummary = {
  readonly assetId: string;
  readonly name: string;
  readonly description: string;
  readonly updatedAtIso: string;
};

export type SkillVersion = SkillCommit & { readonly current: boolean };

export type SkillRegistry = {
  list(caller: SkillCaller): Promise<readonly SkillSummary[]>;
  search(caller: SkillCaller, query: string): Promise<readonly SkillSummary[]>;
  load(caller: SkillCaller, name: string): Promise<SkillDetail>;
  versions(caller: SkillCaller, name: string): Promise<readonly SkillVersion[]>;
  restore(
    caller: SkillCaller,
    name: string,
    commitSha: string,
  ): Promise<SkillDetail>;
  setScope(
    caller: SkillCaller,
    name: string,
    scope: SkillAccessScope,
  ): Promise<SkillSummary>;
  listDrafts(caller: SkillCaller): Promise<readonly SkillDraftSummary[]>;
  createDraft(
    caller: SkillCaller,
    input: {
      readonly name: string;
      readonly description: string;
      readonly body: string;
    },
  ): Promise<SkillDraftSummary>;
  discardDraft(caller: SkillCaller, name: string): Promise<void>;
  publishDraft(
    caller: SkillCaller,
    name: string,
    scope: SkillAccessScope,
  ): Promise<SkillSummary>;
};

export type CreateSkillRegistryDeps = {
  assets: SkillAssetStore;
  access: SkillAccessStore;
};

function draftAssetName(skillName: string): string {
  return `${DRAFT_ASSET_NAME_PREFIX}${skillName}`;
}

function assertSkillName(raw: string): string {
  const parsed = skillNameSchema(raw);
  if (parsed instanceof type.errors) {
    throw new SkillRegistryError(
      "invalid",
      `skill name ${JSON.stringify(raw)} is invalid: ${parsed.summary}`,
    );
  }
  if (parsed.startsWith(DRAFT_ASSET_NAME_PREFIX)) {
    throw new SkillRegistryError(
      "invalid",
      `skill name ${JSON.stringify(raw)} is reserved: the "${DRAFT_ASSET_NAME_PREFIX}" prefix marks a pending draft`,
    );
  }
  return parsed;
}

function assertScope(raw: string): SkillAccessScope {
  const parsed = skillAccessScopeSchema(raw);
  if (parsed instanceof type.errors) {
    throw new SkillRegistryError(
      "invalid",
      `skill scope ${JSON.stringify(raw)} is invalid: ${parsed.summary}`,
    );
  }
  return parsed;
}

function contentErrorToRegistryError(cause: unknown): never {
  if (cause instanceof SkillContentError) {
    throw new SkillRegistryError("invalid", cause.message);
  }
  throw cause;
}

export function createSkillRegistry(
  deps: CreateSkillRegistryDeps,
): SkillRegistry {
  const { assets, access } = deps;

  async function resolveVisible(
    caller: SkillCaller,
    name: string,
  ): Promise<{ row: SkillAccessRow; assetId: string }> {
    const asset = await assets.findByName(caller.tenantId, name);
    if (asset === null) {
      throw new SkillRegistryError("not_found", `no skill named "${name}"`);
    }
    const row = await access.get(asset.id);
    if (row === null || !isSkillVisibleTo(row, caller)) {
      throw new SkillRegistryError("not_found", `no skill named "${name}"`);
    }
    return { row, assetId: asset.id };
  }

  async function readDetail(
    row: SkillAccessRow,
    updatedAtIso: string,
  ): Promise<SkillDetail> {
    const contents = await assets.readSkillMd({
      assetId: row.assetId,
      skillName: row.skillName,
    });
    if (contents === null) {
      throw new SkillRegistryError(
        "not_found",
        `skill "${row.skillName}" has no SKILL.md on its default ref`,
      );
    }
    const parsed = parseSkillMd(contents);
    return {
      assetId: row.assetId,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      scope: row.scope,
      creatorPrincipalId: row.creatorPrincipalId,
      updatedAtIso,
    };
  }

  async function summarize(
    caller: SkillCaller,
    rows: readonly SkillAccessRow[],
  ): Promise<readonly SkillSummary[]> {
    const assetRows = await assets.listForTenant(caller.tenantId);
    const updatedById = new Map(
      assetRows.map((row) => [row.id, row.updatedAt.toISOString()]),
    );
    const out: SkillSummary[] = [];
    for (const row of rows) {
      const contents = await assets.readSkillMd({
        assetId: row.assetId,
        skillName: row.skillName,
      });
      if (contents === null) continue;
      const parsed = parseSkillMd(contents);
      out.push({
        assetId: row.assetId,
        name: parsed.name,
        description: parsed.description,
        scope: row.scope,
        creatorPrincipalId: row.creatorPrincipalId,
        updatedAtIso: updatedById.get(row.assetId) ?? new Date(0).toISOString(),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function visibleRows(
    caller: SkillCaller,
  ): Promise<readonly SkillAccessRow[]> {
    const rows = await access.listForTenant(caller.tenantId);
    return rows.filter((row) => isSkillVisibleTo(row, caller));
  }

  return {
    async list(caller) {
      return summarize(caller, await visibleRows(caller));
    },

    async search(caller, query) {
      const needle = query.trim().toLowerCase();
      const summaries = await summarize(caller, await visibleRows(caller));
      if (needle === "") return summaries;
      return summaries.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) ||
          skill.description.toLowerCase().includes(needle),
      );
    },

    async load(caller, name) {
      const { row } = await resolveVisible(caller, name);
      const assetRows = await assets.listForTenant(caller.tenantId);
      const assetRow = assetRows.find((entry) => entry.id === row.assetId);
      return readDetail(
        row,
        (assetRow?.updatedAt ?? new Date(0)).toISOString(),
      );
    },

    async versions(caller, name) {
      const { row } = await resolveVisible(caller, name);
      const commits = await assets.history(row.assetId);
      return commits.map((commit, index) => ({
        ...commit,
        current: index === 0,
      }));
    },

    async restore(caller, name, commitSha) {
      const { row } = await resolveVisible(caller, name);
      if (!canAdministerSkill(row, caller)) {
        throw new SkillRegistryError(
          "forbidden",
          `only the author of "${name}" may restore one of its versions`,
        );
      }
      const contents = await assets.readSkillMd({
        assetId: row.assetId,
        skillName: row.skillName,
        commitSha,
      });
      if (contents === null) {
        throw new SkillRegistryError(
          "not_found",
          `skill "${name}" has no SKILL.md at commit ${commitSha}`,
        );
      }
      await assets.writeSkillMd({
        assetId: row.assetId,
        skillName: row.skillName,
        contents,
        message: `Restore ${name} to ${commitSha.slice(0, 8)}`,
      });
      return readDetail(row, new Date().toISOString());
    },

    async setScope(caller, name, scope) {
      const parsedScope = assertScope(scope);
      const { row } = await resolveVisible(caller, name);
      if (!canAdministerSkill(row, caller)) {
        throw new SkillRegistryError(
          "forbidden",
          `only the author of "${name}" may change who can see it`,
        );
      }
      const next: SkillAccessRow = {
        assetId: row.assetId,
        tenantId: row.tenantId,
        skillName: row.skillName,
        creatorPrincipalId: row.creatorPrincipalId,
        scope: parsedScope,
      };
      await access.upsert(next);
      const summaries = await summarize(caller, [next]);
      const summary = summaries[0];
      if (summary === undefined) {
        throw new SkillRegistryError(
          "not_found",
          `skill "${name}" has no SKILL.md on its default ref`,
        );
      }
      return summary;
    },

    async listDrafts(caller) {
      const assetRows = await assets.listForTenant(caller.tenantId);
      const drafts: SkillDraftSummary[] = [];
      for (const assetRow of assetRows) {
        if (!assetRow.name.startsWith(DRAFT_ASSET_NAME_PREFIX)) continue;
        if (assetRow.creatorPrincipalId !== caller.principalId) continue;
        const skillName = assetRow.name.slice(DRAFT_ASSET_NAME_PREFIX.length);
        const contents = await assets.readSkillMd({
          assetId: assetRow.id,
          skillName,
        });
        if (contents === null) continue;
        const parsed = parseSkillMd(contents);
        drafts.push({
          assetId: assetRow.id,
          name: parsed.name,
          description: parsed.description,
          updatedAtIso: assetRow.updatedAt.toISOString(),
        });
      }
      return drafts.sort((a, b) => a.name.localeCompare(b.name));
    },

    async createDraft(caller, input) {
      const name = assertSkillName(input.name);
      let contents: string;
      try {
        contents = buildSkillMd({
          name,
          description: input.description,
          body: input.body,
        });
      } catch (cause) {
        contentErrorToRegistryError(cause);
      }
      const published = await assets.findByName(caller.tenantId, name);
      if (published !== null) {
        throw new SkillRegistryError(
          "conflict",
          `a skill named "${name}" already exists in this workbench`,
        );
      }
      const draftName = draftAssetName(name);
      const existingDraft = await assets.findByName(caller.tenantId, draftName);
      if (existingDraft !== null) {
        throw new SkillRegistryError(
          "conflict",
          `a draft of "${name}" is already pending`,
        );
      }
      const created = await assets.create({
        tenantId: caller.tenantId,
        name: draftName,
        displayName: name,
        creatorPrincipalId: caller.principalId,
      });
      await assets.writeSkillMd({
        assetId: created.id,
        skillName: name,
        contents,
        message: `Draft ${name}`,
      });
      return {
        assetId: created.id,
        name,
        description: parseSkillMd(contents).description,
        updatedAtIso: created.updatedAt.toISOString(),
      };
    },

    async discardDraft(caller, name) {
      const draft = await assets.findByName(
        caller.tenantId,
        draftAssetName(name),
      );
      if (draft === null || draft.creatorPrincipalId !== caller.principalId) {
        throw new SkillRegistryError(
          "not_found",
          `no pending draft of "${name}"`,
        );
      }
      await assets.remove(draft.id);
    },

    async publishDraft(caller, name, scope) {
      const parsedScope = assertScope(scope);
      const skillName = assertSkillName(name);
      const draft = await assets.findByName(
        caller.tenantId,
        draftAssetName(skillName),
      );
      if (draft === null || draft.creatorPrincipalId !== caller.principalId) {
        throw new SkillRegistryError(
          "not_found",
          `no pending draft of "${skillName}"`,
        );
      }
      const contents = await assets.readSkillMd({
        assetId: draft.id,
        skillName,
      });
      if (contents === null) {
        throw new SkillRegistryError(
          "not_found",
          `draft of "${skillName}" has no SKILL.md`,
        );
      }
      const existing = await assets.findByName(caller.tenantId, skillName);
      if (existing !== null) {
        throw new SkillRegistryError(
          "conflict",
          `a skill named "${skillName}" already exists in this workbench`,
        );
      }
      const published = await assets.create({
        tenantId: caller.tenantId,
        name: skillName,
        displayName: skillName,
        creatorPrincipalId: caller.principalId,
      });
      await assets.writeSkillMd({
        assetId: published.id,
        skillName,
        contents,
        message: `Publish ${skillName}`,
      });
      const row: SkillAccessRow = {
        assetId: published.id,
        tenantId: caller.tenantId,
        skillName,
        creatorPrincipalId: caller.principalId,
        scope: parsedScope,
      };
      await access.upsert(row);
      // Last: until the draft asset is gone the skill is still pending,
      // so a failure anywhere above leaves a retryable draft rather than
      // an orphaned half-published skill.
      await assets.remove(draft.id);
      const summaries = await summarize(caller, [row]);
      const summary = summaries[0];
      if (summary === undefined) {
        throw new SkillRegistryError(
          "not_found",
          `published skill "${skillName}" is not readable back`,
        );
      }
      return summary;
    },
  };
}
