// The skill registry. One surface, one store: every skill is a native
// `kind:"skill"` hub asset carrying a single `<name>/SKILL.md`, and every
// version of it is a commit on that asset's default ref. Visibility lives
// in the SKILL.md frontmatter — the asset's own bytes — so there is no
// side table to drift from the content it gates. Creating a skill creates
// that asset directly — there is no intermediate pending state.
import type {
  SkillAssetRow,
  SkillAssetStore,
  SkillCommit,
} from "./asset-store";
import {
  buildSkillMd,
  parseSkillMd,
  skillDescriptionSchema,
  skillNameSchema,
  skillScopeSchema,
  SkillContentError,
  type ParsedSkillMd,
  type SkillScope,
} from "./skill-md";
import { type } from "arktype";

export type SkillRegistryErrorReason =
  "not_found" | "forbidden" | "conflict" | "invalid";

export class SkillRegistryError extends Error {
  readonly reason: SkillRegistryErrorReason;
  /** The validator's raw diagnostic (an arktype summary can quote a regex
   * literal) — for logs and debugging, never for the message a person
   * reads, which stays plain language. */
  readonly details?: string | undefined;
  constructor(
    reason: SkillRegistryErrorReason,
    message: string,
    details?: string | undefined,
  ) {
    super(message);
    this.name = "SkillRegistryError";
    this.reason = reason;
    this.details = details;
  }
}

export type SkillCaller = {
  readonly tenantId: string;
  readonly principalId: string;
};

/** A skill as the registry resolved it: the parsed tip SKILL.md plus the
 * asset it was read from. Scope and authorship both come from these two —
 * nothing else is consulted. */
type ResolvedSkill = {
  readonly asset: SkillAssetRow;
  readonly parsed: ParsedSkillMd;
  readonly updatedAtIso: string;
};

export type SkillSummary = {
  readonly assetId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly creatorPrincipalId: string;
  readonly updatedAtIso: string;
};

export type SkillDetail = SkillSummary & { readonly body: string };

export type SkillVersion = SkillCommit & { readonly current: boolean };

export type SkillRegistry = {
  list(caller: SkillCaller): Promise<readonly SkillSummary[]>;
  search(caller: SkillCaller, query: string): Promise<readonly SkillSummary[]>;
  load(caller: SkillCaller, name: string): Promise<SkillDetail>;
  versions(caller: SkillCaller, name: string): Promise<readonly SkillVersion[]>;
  /** The skill exactly as it stood at one commit — what a diff against the
   * current version is computed from. Read-only: nothing is written and no
   * version is cut. */
  versionContent(
    caller: SkillCaller,
    name: string,
    commitSha: string,
  ): Promise<SkillDetail>;
  restore(
    caller: SkillCaller,
    name: string,
    commitSha: string,
  ): Promise<SkillDetail>;
  /** Republishes the skill's current content under a new scope as its own
   * commit, so the previous scope stays restorable like any other version.
   * Only the skill's own creator may rescope it. */
  setScope(
    caller: SkillCaller,
    name: string,
    scope: SkillScope,
  ): Promise<SkillSummary>;
  create(
    caller: SkillCaller,
    input: {
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly scope: SkillScope;
    },
  ): Promise<SkillSummary>;
  /** Republishes an existing skill's body/description as a new commit on
   * its same asset, scope untouched — only the skill's own creator may
   * `update` it. Distinct from `create`, which always 409s on a name a
   * fully-formed skill already owns (see `create`'s own conflict
   * handling). */
  update(
    caller: SkillCaller,
    name: string,
    input: {
      readonly description: string;
      readonly body: string;
      /** The commit the editor's content was read from. When given and no
       * longer the current commit, the write is refused as a conflict
       * rather than silently burying whoever saved in between. */
      readonly expectedHeadSha?: string | undefined;
    },
  ): Promise<SkillSummary>;
};

export type CreateSkillRegistryDeps = {
  assets: SkillAssetStore;
};

/** True when an arktype failure includes a regex `pattern` check — the
 * one failure mode whose default summary quotes the raw regex literal,
 * which is implementation detail no end user should see. */
function isPatternFailure(errors: type.errors): boolean {
  return errors.some((error) => error.code === "pattern");
}

function assertSkillName(raw: string): string {
  const parsed = skillNameSchema(raw);
  if (parsed instanceof type.errors) {
    throw new SkillRegistryError(
      "invalid",
      isPatternFailure(parsed)
        ? "Name must be lowercase letters, digits, and hyphens."
        : `skill name ${JSON.stringify(raw)} is invalid: ${parsed.summary}`,
      parsed.summary,
    );
  }
  return parsed;
}

function assertDescription(raw: string): string {
  const parsed = skillDescriptionSchema(raw);
  if (parsed instanceof type.errors) {
    throw new SkillRegistryError(
      "invalid",
      isPatternFailure(parsed)
        ? "Description can't contain HTML tags."
        : `skill description is invalid: ${parsed.summary}`,
      parsed.summary,
    );
  }
  return parsed;
}

function assertScope(raw: string): SkillScope {
  const parsed = skillScopeSchema(raw);
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

/**
 * A `tenant`-scoped skill is visible to every principal in the tenant
 * that can already reach the asset; a `private` one only to the principal
 * who created it, tenant notwithstanding — a private skill inherited from
 * a parent stays invisible to everyone in the child but its author.
 *
 * This predicate only ever runs on assets `SkillAssetStore.findByName`
 * and `SkillAssetStore.listForTenant` already resolved, both of which
 * bound their results to the caller's own tenant plus its ancestors (the
 * same chain-walk the native asset resolver uses) — so the tenant
 * boundary is enforced once, at the resolution layer, not duplicated
 * here. This function's whole job is the scope check.
 */
function isSkillVisibleTo(skill: ResolvedSkill, caller: SkillCaller): boolean {
  if (skill.parsed.scope === "tenant") return true;
  return skill.asset.creatorPrincipalId === caller.principalId;
}

/**
 * Only the creating principal, calling from the tenant that owns the
 * skill, may republish, restore, or change its scope. An asset inherited
 * from an ancestor tenant is never administerable from a descendant —
 * even by its own author — so writes never touch an ancestor's asset;
 * the registry refuses those explicitly rather than silently forking a
 * copy (see `requireOwnTenant`).
 */
function canAdministerSkill(
  skill: ResolvedSkill,
  caller: SkillCaller,
): boolean {
  return (
    skill.asset.tenantId === caller.tenantId &&
    skill.asset.creatorPrincipalId === caller.principalId
  );
}

/**
 * Guards every write path (`update`, `restore`, `setScope`). A skill
 * inherited from an ancestor tenant is refused loudly and specifically —
 * never silently forked into a same-named copy in the caller's own
 * tenant — before falling through to the ordinary "only the author"
 * check for skills the caller's own tenant does own.
 */
function requireOwnTenant(
  skill: ResolvedSkill,
  caller: SkillCaller,
  name: string,
  action: string,
): void {
  if (skill.asset.tenantId !== caller.tenantId) {
    throw new SkillRegistryError(
      "forbidden",
      `"${name}" is inherited from a parent workbench — ${action} it from the workbench that owns it, not from a child.`,
    );
  }
  if (!canAdministerSkill(skill, caller)) {
    throw new SkillRegistryError(
      "forbidden",
      `only the author of "${name}" may ${action} it`,
    );
  }
}

function summarize(skill: ResolvedSkill): SkillSummary {
  return {
    assetId: skill.asset.id,
    name: skill.parsed.name,
    description: skill.parsed.description,
    scope: skill.parsed.scope,
    creatorPrincipalId: skill.asset.creatorPrincipalId ?? "unknown",
    updatedAtIso: skill.updatedAtIso,
  };
}

function detailOf(skill: ResolvedSkill): SkillDetail {
  return { ...summarize(skill), body: skill.parsed.body };
}

export function createSkillRegistry(
  deps: CreateSkillRegistryDeps,
): SkillRegistry {
  const { assets } = deps;

  /** Reads a skill's tip SKILL.md and parses it. Returns null when the
   * asset carries no SKILL.md yet — the half-written state a crashed
   * `create` leaves behind — so callers treat it as invisible rather
   * than as a skill with empty content. */
  async function readTip(asset: SkillAssetRow): Promise<ResolvedSkill | null> {
    const contents = await assets.readSkillMd({
      assetId: asset.id,
      skillName: asset.name,
    });
    if (contents === null) return null;
    return {
      asset,
      parsed: parseSkillMd(contents),
      updatedAtIso: asset.updatedAt.toISOString(),
    };
  }

  async function resolveVisible(
    caller: SkillCaller,
    name: string,
  ): Promise<ResolvedSkill> {
    const asset = await assets.findByName(caller.tenantId, name);
    if (asset === null) {
      throw new SkillRegistryError("not_found", `no skill named "${name}"`);
    }
    const skill = await readTip(asset);
    if (skill === null || !isSkillVisibleTo(skill, caller)) {
      throw new SkillRegistryError("not_found", `no skill named "${name}"`);
    }
    return skill;
  }

  async function visibleSkills(
    caller: SkillCaller,
  ): Promise<readonly ResolvedSkill[]> {
    const assetRows = await assets.listForTenant(caller.tenantId);
    const out: ResolvedSkill[] = [];
    for (const asset of assetRows) {
      const skill = await readTip(asset);
      if (skill === null) continue;
      if (!isSkillVisibleTo(skill, caller)) continue;
      out.push(skill);
    }
    return out.sort((a, b) => a.parsed.name.localeCompare(b.parsed.name));
  }

  return {
    async list(caller) {
      return (await visibleSkills(caller)).map(summarize);
    },

    async search(caller, query) {
      const needle = query.trim().toLowerCase();
      const skills = await visibleSkills(caller);
      if (needle === "") return skills.map(summarize);
      return skills
        .filter(
          (skill) =>
            skill.parsed.name.toLowerCase().includes(needle) ||
            skill.parsed.description.toLowerCase().includes(needle),
        )
        .map(summarize);
    },

    async load(caller, name) {
      return detailOf(await resolveVisible(caller, name));
    },

    async versions(caller, name) {
      const skill = await resolveVisible(caller, name);
      const commits = await assets.history(skill.asset.id);
      return commits.map((commit, index) => ({
        ...commit,
        current: index === 0,
      }));
    },

    async versionContent(caller, name, commitSha) {
      const skill = await resolveVisible(caller, name);
      const contents = await assets.readSkillMd({
        assetId: skill.asset.id,
        skillName: skill.asset.name,
        commitSha,
      });
      if (contents === null) {
        throw new SkillRegistryError(
          "not_found",
          `skill "${name}" has no SKILL.md at commit ${commitSha}`,
        );
      }
      const commit = (await assets.history(skill.asset.id)).find(
        (entry) => entry.commitSha === commitSha,
      );
      if (commit === undefined) {
        throw new SkillRegistryError(
          "not_found",
          `commit ${commitSha} is not in "${name}"'s history`,
        );
      }
      const parsed = parseSkillMd(contents);
      return {
        assetId: skill.asset.id,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        scope: parsed.scope,
        creatorPrincipalId: skill.asset.creatorPrincipalId ?? "unknown",
        updatedAtIso: commit.committedAtIso,
      };
    },

    async restore(caller, name, commitSha) {
      const skill = await resolveVisible(caller, name);
      requireOwnTenant(skill, caller, name, "restore");
      const contents = await assets.readSkillMd({
        assetId: skill.asset.id,
        skillName: skill.asset.name,
        commitSha,
      });
      if (contents === null) {
        throw new SkillRegistryError(
          "not_found",
          `skill "${name}" has no SKILL.md at commit ${commitSha}`,
        );
      }
      await assets.writeSkillMd({
        assetId: skill.asset.id,
        skillName: skill.asset.name,
        contents,
        message: `Restore ${name} to ${commitSha.slice(0, 8)}`,
      });
      const restored = await readTip(skill.asset);
      if (restored === null) {
        throw new SkillRegistryError(
          "not_found",
          `skill "${name}" has no SKILL.md on its default ref`,
        );
      }
      return detailOf(restored);
    },

    async setScope(caller, name, scope) {
      const parsedScope = assertScope(scope);
      const skill = await resolveVisible(caller, name);
      requireOwnTenant(skill, caller, name, "change who can see");
      const rescoped = buildSkillMd({
        name: skill.parsed.name,
        description: skill.parsed.description,
        scope: parsedScope,
        body: skill.parsed.body,
      });
      await assets.writeSkillMd({
        assetId: skill.asset.id,
        skillName: skill.asset.name,
        contents: rescoped,
        message: `Set scope of ${name} to ${parsedScope}`,
      });
      const updated = await readTip(skill.asset);
      if (updated === null) {
        throw new SkillRegistryError(
          "not_found",
          `skill "${name}" has no SKILL.md on its default ref`,
        );
      }
      return summarize(updated);
    },

    async create(caller, input) {
      const name = assertSkillName(input.name);
      const description = assertDescription(input.description);
      const parsedScope = assertScope(input.scope);
      let contents: string;
      try {
        contents = buildSkillMd({
          name,
          description,
          scope: parsedScope,
          body: input.body,
        });
      } catch (cause) {
        contentErrorToRegistryError(cause);
      }

      async function finish(asset: SkillAssetRow): Promise<SkillSummary> {
        const skill = await readTip(asset);
        if (skill === null) {
          throw new SkillRegistryError(
            "not_found",
            `created skill "${name}" is not readable back`,
          );
        }
        return summarize(skill);
      }

      // Own-tenant only, deliberately not inheritance-aware: a name
      // already claimed by an ancestor's skill must not block this
      // tenant from creating its own — that's the shadowing contract,
      // not a conflict.
      const existing = await assets.findOwnByName(caller.tenantId, name);
      if (existing !== null) {
        const existingSkill = await readTip(existing);
        if (
          existingSkill !== null ||
          existing.creatorPrincipalId !== caller.principalId
        ) {
          // Either a fully-formed skill already owns this name, or the
          // orphaned asset was started by someone else — neither is this
          // caller's to complete.
          throw new SkillRegistryError(
            "conflict",
            `a skill named "${name}" already exists in this workbench`,
          );
        }
        // The asset exists but carries no SKILL.md yet: a prior create
        // for this exact name got as far as `assets.create` and then
        // failed or timed out before the SKILL.md commit landed. Finish
        // it — write the commit, never re-create the asset — rather than
        // 409ing on a name this same caller can never use again.
        await assets.writeSkillMd({
          assetId: existing.id,
          skillName: name,
          contents,
          message: `Create ${name}`,
        });
        return finish(existing);
      }

      const created = await assets.create({
        tenantId: caller.tenantId,
        name,
        displayName: name,
        creatorPrincipalId: caller.principalId,
      });
      await assets.writeSkillMd({
        assetId: created.id,
        skillName: name,
        contents,
        message: `Create ${name}`,
      });
      return finish(created);
    },

    async update(caller, name, input) {
      const parsedName = assertSkillName(name);
      const description = assertDescription(input.description);
      const skill = await resolveVisible(caller, parsedName);
      requireOwnTenant(skill, caller, parsedName, "update");
      if (input.expectedHeadSha !== undefined) {
        const head = (await assets.history(skill.asset.id))[0];
        if (head?.commitSha !== input.expectedHeadSha) {
          throw new SkillRegistryError(
            "conflict",
            `"${parsedName}" changed since this edit started — review the current version before saving.`,
          );
        }
      }
      let contents: string;
      try {
        contents = buildSkillMd({
          name: parsedName,
          description,
          scope: skill.parsed.scope,
          body: input.body,
        });
      } catch (cause) {
        contentErrorToRegistryError(cause);
      }
      await assets.writeSkillMd({
        assetId: skill.asset.id,
        skillName: parsedName,
        contents,
        message: `Update ${parsedName}`,
      });
      const updated = await readTip(skill.asset);
      if (updated === null) {
        throw new SkillRegistryError(
          "not_found",
          `updated skill "${parsedName}" is not readable back`,
        );
      }
      return summarize(updated);
    },
  };
}
