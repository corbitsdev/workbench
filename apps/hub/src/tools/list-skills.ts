import type { AgentTool } from "@intx/agent";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import type { RepoStore } from "@workbench/hub-sessions";
import {
  DRAFT_SKILL_DEFINITION,
  LIST_SKILL_DRAFTS_DEFINITION,
  LIST_SKILLS_DEFINITION,
  LOAD_SKILL_DEFINITION,
  LOAD_SKILL_DRAFT_DEFINITION,
  SEARCH_SKILLS_DEFINITION,
  parseDraftSkillArgs,
  parseSearchQuery,
  parseSkillDraftId,
  parseSkillId,
  skillMatchesQuery,
  type SkillIndexEntry,
} from "@workbench/tools-skills";
import { and, eq } from "drizzle-orm";
import { skillTitle } from "@workbench/shared";
import type { HubDb } from "../db";
import { resolveOwnerMemberPrincipalId } from "../lib/artifact-tools";
import type { UserContext } from "../lib/user-context";
import { artifact } from "../db/schema";
import {
  getOwnedSkillDraftItem,
  getSkillAsset,
  getSkillContent,
  listSkillDrafts,
  listSkills,
  matchSkillIdByDraftName,
  type SkillItem,
} from "../services/skill-library";
import { writeArtifactDeduped } from "./write-artifact";
import type { ContextToolEntry } from "../lib/tool-registry";

const log = getLogger(["api", "skill-tools"]);

export {
  LIST_SKILLS_DEFINITION,
  SEARCH_SKILLS_DEFINITION,
  LOAD_SKILL_DEFINITION,
  LIST_SKILL_DRAFTS_DEFINITION,
  LOAD_SKILL_DRAFT_DEFINITION,
  DRAFT_SKILL_DEFINITION,
} from "@workbench/tools-skills";

export type SkillToolsContext = {
  db: HubDb;
  repoStore: RepoStore;
  tenantId: string;
  principalId: string;
};

/**
 * The skill library tools resolve visibility by the STABLE user id, not the
 * per-instance synthetic principal. The instance's principal carries the
 * user's `refId`; resolve it so a private skill is only visible to its owner.
 * Returns null when the principal is not a resolvable active user (e.g. a
 * dispatched agent) — the handler then fails closed.
 */
async function resolveViewerUserId(
  db: HubDb,
  tenantId: string,
  principalId: string,
): Promise<string | null> {
  const principal = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.id, principalId),
      eq(intxSchema.principal.tenantId, tenantId),
    ),
  });
  if (!principal) {
    // Unknown/foreign/deleted principal — denied by design; log so the
    // fail-closed empty result is observable rather than a silent "no skills".
    log.warn("skill tools: principal not found; denying skill access", {
      principalId,
      tenantId,
    });
  } else if (!principal.refId) {
    // A principal with no stable user id (e.g. a synthetic/dispatched agent)
    // is denied by design; log so the fail-closed empty result is observable.
    log.warn("skill tools: principal has no refId; denying skill access", {
      principalId,
      tenantId,
    });
  }
  return principal?.refId ?? null;
}

function toIndexEntry(skill: SkillItem): SkillIndexEntry {
  return {
    id: skill.id,
    name: skill.name,
    displayName: skillTitle(skill),
    description: skill.description,
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Bound what load_skill returns so a large skill cannot dump megabytes into the
// model's context / inference bill. Skills can legitimately be created up to a
// 20MB bundle; the agent only needs the readable text, truncated with a signal.
const MAX_SKILL_FILE_CHARS = 256 * 1024;
const MAX_SKILL_LOAD_CHARS = 1024 * 1024;

type LoadedFile = {
  path: string;
  content?: string;
  truncated?: true;
  omitted?: string;
};

/**
 * Clamp one file's content against a shared character budget. Binary/unreadable
 * files (no content) and content past the budget are reported with an explicit
 * marker rather than emitted as a silent empty/oversized blob.
 */
function clampContent(
  content: string | undefined,
  budget: { remaining: number },
): { content?: string; truncated?: true; omitted?: string } {
  if (content === undefined)
    return { omitted: "binary or non-text file; not included" };
  if (budget.remaining <= 0)
    return { omitted: "omitted: load size limit reached" };
  const allowed = Math.min(
    content.length,
    MAX_SKILL_FILE_CHARS,
    budget.remaining,
  );
  budget.remaining -= allowed;
  if (allowed < content.length)
    return { content: content.slice(0, allowed), truncated: true };
  return { content };
}

async function visibleIndex(
  context: SkillToolsContext,
): Promise<SkillIndexEntry[]> {
  const userId = await resolveViewerUserId(
    context.db,
    context.tenantId,
    context.principalId,
  );
  if (userId === null) return [];
  const skills = await listSkills(context.db, {
    tenantId: context.tenantId,
    userId,
  });
  return skills.map(toIndexEntry);
}

async function listSkillsHandler(context: SkillToolsContext): Promise<string> {
  return jsonResult({ skills: await visibleIndex(context) });
}

async function searchSkillsHandler(
  context: SkillToolsContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = parseSearchQuery(args);
  const index = await visibleIndex(context);
  return jsonResult({
    skills: index.filter((entry) => skillMatchesQuery(entry, query)),
  });
}

async function loadSkillHandler(
  context: SkillToolsContext,
  args: Record<string, unknown>,
): Promise<string> {
  const id = parseSkillId(args);
  const userId = await resolveViewerUserId(
    context.db,
    context.tenantId,
    context.principalId,
  );
  if (userId === null) {
    throw new Error(`Skill not found: ${id}`);
  }
  // getSkillAsset enforces the same visibility rule as the library list: a
  // skill not in the viewer's tenant chain, or a private skill the viewer does
  // not own, resolves to null and is reported as not found.
  const skill = await getSkillAsset(
    context.db,
    { tenantId: context.tenantId, userId },
    id,
  );
  if (!skill) {
    throw new Error(`Skill not found: ${id}`);
  }
  const files = await getSkillContent(context.repoStore, skill.id, skill.name);
  const entrypoint = files.find((file) => file.path === "SKILL.md");
  const siblings = files.filter((file) => file.path !== "SKILL.md");

  const budget = { remaining: MAX_SKILL_LOAD_CHARS };
  const bodyClamped = clampContent(entrypoint?.content ?? "", budget);
  const loadedSiblings: LoadedFile[] = siblings.map((file) => ({
    path: file.path,
    ...clampContent(file.content, budget),
  }));
  const truncated =
    bodyClamped.truncated === true ||
    loadedSiblings.some((f) => f.truncated || f.omitted);

  return jsonResult({
    id: skill.id,
    name: skill.name,
    displayName: skillTitle(skill),
    body: bodyClamped.content ?? "",
    files: loadedSiblings,
    ...(truncated
      ? {
          notice:
            "Some content was truncated or omitted due to load size limits.",
        }
      : {}),
  });
}

/**
 * Pending drafts are owned by the human MEMBER principal (stamped by
 * skill_draft), not the agent principal. Resolve the owning member so the draft
 * read tools authorize against the same id skill_draft writes and approve reads.
 * Returns null when the agent has no owning member (fail closed).
 */
async function resolveOwnerContext(
  context: SkillToolsContext,
): Promise<UserContext | null> {
  const ownerPrincipalId = await resolveOwnerMemberPrincipalId(
    context.db as DB["db"],
    { tenantId: context.tenantId, principalId: context.principalId },
  );
  if (ownerPrincipalId === null) return null;
  return { tenantId: context.tenantId, principalId: ownerPrincipalId };
}

async function listSkillDraftsHandler(
  context: SkillToolsContext,
): Promise<string> {
  const owner = await resolveOwnerContext(context);
  if (owner === null) return jsonResult({ drafts: [] });
  const drafts = await listSkillDrafts(context.db, owner);
  return jsonResult({
    drafts: drafts.map((draft) => ({
      id: draft.id,
      name: draft.title,
      description: draft.description,
    })),
  });
}

async function loadSkillDraftHandler(
  context: SkillToolsContext,
  args: Record<string, unknown>,
): Promise<string> {
  const id = parseSkillDraftId(args);
  const owner = await resolveOwnerContext(context);
  if (owner === null) {
    throw new Error(`Skill draft not found: ${id}`);
  }
  const draft = await getOwnedSkillDraftItem(context.db, owner, id);

  const budget = { remaining: MAX_SKILL_LOAD_CHARS };
  const bodyClamped = clampContent(draft.content, budget);
  const loadedFiles: LoadedFile[] = draft.files.map((file) => ({
    path: file.path,
    ...clampContent(file.content, budget),
  }));
  const truncated =
    bodyClamped.truncated === true ||
    loadedFiles.some((f) => f.truncated || f.omitted);

  return jsonResult({
    id: draft.id,
    name: draft.title,
    description: draft.description,
    existingSkillId: draft.existingSkillId,
    body: bodyClamped.content ?? "",
    files: loadedFiles,
    ...(truncated
      ? {
          notice:
            "Some content was truncated or omitted due to load size limits.",
        }
      : {}),
  });
}

async function skillDraftHandler(
  context: SkillToolsContext,
  args: Record<string, unknown>,
): Promise<string> {
  const draft = parseDraftSkillArgs(args);
  const source: Record<string, unknown> = { origin: "skill-draft" };
  if (draft.description !== undefined) source.description = draft.description;
  if (draft.files && draft.files.length > 0) source.files = draft.files;

  // Stamp the human owner (Myra's member principal), not the agent principal.
  // Approve/list authorize against this id so the human can act on their agent's drafts.
  const ownerPrincipalId = await resolveOwnerMemberPrincipalId(
    context.db as DB["db"],
    { tenantId: context.tenantId, principalId: context.principalId },
  );
  if (ownerPrincipalId === null) {
    throw new Error(
      "Cannot draft a skill: agent has no owning member principal",
    );
  }

  // Prefer an explicit existingSkillId; otherwise resolve a library skill by
  // asset slug / displayName so a second draft revises rather than 409-create.
  // Draft titles are often display-ish ("Company Research"); library name is
  // the kebab slug from toAssetName.
  let existingSkillId = draft.existingSkillId;
  if (!existingSkillId) {
    const userId = await resolveViewerUserId(
      context.db,
      context.tenantId,
      context.principalId,
    );
    if (userId !== null) {
      const visible = await listSkills(context.db, {
        tenantId: context.tenantId,
        userId,
      });
      const matched = matchSkillIdByDraftName(visible, draft.name);
      if (matched) existingSkillId = matched;
    }
  }

  // Preserve a prior stamp on the same principal+title draft row —
  // writeArtifactDeduped replaces source wholesale.
  if (!existingSkillId) {
    const prior = await context.db
      .select({ source: artifact.source })
      .from(artifact)
      .where(
        and(
          eq(artifact.tenantId, context.tenantId),
          eq(artifact.principalId, context.principalId),
          eq(artifact.title, draft.name),
          eq(artifact.kind, "skill-draft"),
        ),
      )
      .limit(1);
    const priorSource = (prior[0]?.source ?? {}) as Record<string, unknown>;
    const priorId =
      typeof priorSource.existingSkillId === "string" &&
      priorSource.existingSkillId
        ? priorSource.existingSkillId
        : null;
    if (priorId) existingSkillId = priorId;
  }

  if (existingSkillId) source.existingSkillId = existingSkillId;

  const result = await writeArtifactDeduped({
    db: context.db as DB["db"],
    tenantId: context.tenantId,
    principalId: context.principalId,
    title: draft.name,
    body: draft.body,
    kind: "skill-draft",
    source,
    ownerPrincipalId,
  });

  return JSON.stringify({
    draftId: result.artifactId,
    version: result.version,
    ...(existingSkillId ? { existingSkillId } : {}),
  });
}

export function createSkillTools(context: SkillToolsContext): AgentTool[] {
  return [
    {
      kind: "string",
      definition: LIST_SKILLS_DEFINITION,
      handler: () => listSkillsHandler(context),
    },
    {
      kind: "string",
      definition: SEARCH_SKILLS_DEFINITION,
      handler: (args) => searchSkillsHandler(context, args),
    },
    {
      kind: "string",
      definition: LOAD_SKILL_DEFINITION,
      handler: (args) => loadSkillHandler(context, args),
    },
    {
      kind: "string",
      definition: LIST_SKILL_DRAFTS_DEFINITION,
      handler: () => listSkillDraftsHandler(context),
    },
    {
      kind: "string",
      definition: LOAD_SKILL_DRAFT_DEFINITION,
      handler: (args) => loadSkillDraftHandler(context, args),
    },
    {
      kind: "string",
      definition: DRAFT_SKILL_DEFINITION,
      handler: (args) => skillDraftHandler(context, args),
    },
  ];
}

function requireSkillContext(context: {
  db: unknown;
  repoStore?: RepoStore;
  tenantId: string;
  principalId: string;
}): SkillToolsContext {
  if (!context.repoStore) {
    throw new Error("Skill tools require a repoStore in the hub tool context");
  }
  // The registry types `db` against the Interchange schema; the runtime value
  // is the hub db (a superset). The skill-library service is hub-internal and
  // needs the hub schema accessor, so narrow here at the single boundary.
  return {
    db: context.db as HubDb,
    repoStore: context.repoStore,
    tenantId: context.tenantId,
    principalId: context.principalId,
  };
}

export const SKILLS_HUB_TOOLS: Record<string, ContextToolEntry> = {
  list_skills: {
    sideEffect: "read",
    definition: LIST_SKILLS_DEFINITION,
    createTools: (context) => createSkillTools(requireSkillContext(context)),
  },
  search_skills: {
    sideEffect: "read",
    definition: SEARCH_SKILLS_DEFINITION,
    createTools: (context) => createSkillTools(requireSkillContext(context)),
  },
  load_skill: {
    sideEffect: "read",
    definition: LOAD_SKILL_DEFINITION,
    createTools: (context) => createSkillTools(requireSkillContext(context)),
  },
  list_skill_drafts: {
    sideEffect: "read",
    definition: LIST_SKILL_DRAFTS_DEFINITION,
    createTools: (context) => createSkillTools(requireSkillContext(context)),
  },
  load_skill_draft: {
    sideEffect: "read",
    definition: LOAD_SKILL_DRAFT_DEFINITION,
    createTools: (context) => createSkillTools(requireSkillContext(context)),
  },
  skill_draft: {
    sideEffect: "write",
    definition: DRAFT_SKILL_DEFINITION,
    createTools: (context) => createSkillTools(requireSkillContext(context)),
  },
};
