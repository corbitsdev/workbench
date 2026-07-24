import type { AuthorizeFn, KindHandler, Principal, ValidatePushResult } from "./repo-store";

// CL-4215: skill drafts are storage-only. They exist so a human/agent can
// author a skill's content under git-backed review, and are read back by
// the skill-library service (hub-side) and rendered in the web UI's Pending
// drafts panel. They are NEVER attached to an agent session — only the
// published `skill` kind goes through the available-skills attach path — so
// this handler does not need to satisfy any pack/attachment tree shape, and
// `validatePush` only needs to guard the two consumers that actually write
// and read draft content: the `skill_draft` hub tool and the skill-library
// service's approve/discard/reinstate paths.
//
// Content shape (single skill per repo, unlike the multi-skill `skill` kind
// repo): everything lives under a fixed `draft/` prefix so the writer can
// use `clearPrefix: "draft/"` to fully replace the tree on every re-author
// (stale support files from a prior version don't linger) — the same
// technique `skill-kind`'s multi-skill repo uses per-asset-name, narrowed
// to one fixed prefix since a draft repo holds exactly one draft.
// `draft/SKILL.md` is the raw body (no synthesized frontmatter — a draft
// need not yet be a publishable skill), any support files sit alongside it
// at their given relative paths, and `draft/.draft-meta.json` carries
// `{ description, existingSkillId }` — review-relevant metadata with no
// natural home on the asset row (no new columns, per the ticket) that
// travels with the git-backed content itself.
export type SkillDraftHubPrincipal = { readonly kind: "hub" };

export const SKILL_DRAFT_PREFIX = "draft/";
export const SKILL_DRAFT_ENTRYPOINT = `${SKILL_DRAFT_PREFIX}SKILL.md`;
export const SKILL_DRAFT_META_PATH = `${SKILL_DRAFT_PREFIX}.draft-meta.json`;

export const skillDraftKindHandler: KindHandler = {
  kind: "skill-draft",
  directoryPrefix: "assets/skill-draft",
  async validatePush({ readBlob }): Promise<ValidatePushResult> {
    let body: Uint8Array;
    try {
      body = await readBlob(SKILL_DRAFT_ENTRYPOINT);
    } catch {
      return {
        ok: false,
        reason: `skill-draft push is missing ${SKILL_DRAFT_ENTRYPOINT}`,
      };
    }
    if (body.byteLength === 0) {
      return {
        ok: false,
        reason: `skill-draft ${SKILL_DRAFT_ENTRYPOINT} must not be empty`,
      };
    }
    return { ok: true };
  },
  // No index to maintain — draft content is read straight from git on
  // demand (skill-library.ts's `loadSkillDraftContent`), unlike the
  // multi-skill `skill` kind's in-memory frontmatter index.
  onRefUpdated() {},
};

/**
 * skill-draft repos are written and read exclusively by the hub process
 * (the `skill_draft` tool, and the skill-library service's approve/discard/
 * reinstate paths) — never by a sidecar and never over the smart-HTTP wire
 * protocol, because drafts never attach to a session. Only the `hub`
 * principal is authorized for any action; every other principal kind is
 * denied so a future accidental wire-exposure of this kind fails loudly
 * instead of silently granting access.
 */
export const skillDraftAuthorize: AuthorizeFn = (
  principal: Principal,
  repoId,
  _ref,
  action,
) => {
  if (repoId.kind !== "skill-draft") {
    return {
      allowed: false,
      reason: `skill-draft authorize received non-skill-draft repo ${repoId.kind}/${repoId.id}`,
    };
  }
  if (principal.kind === "hub") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `skill drafts are hub-managed storage only; principal kind ${JSON.stringify(
      principal.kind,
    )} may not ${action} them`,
  };
};
