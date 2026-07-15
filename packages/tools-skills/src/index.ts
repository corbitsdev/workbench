import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";

/**
 * Read-only access to the tenant-visible skill library with progressive
 * disclosure. The definitions live here; execution happens hub-side because
 * skill content lives in the hub-owned asset git store and visibility is
 * resolved against hub-owned tables. These tools coexist with per-agent skill
 * attachment — they reach the whole library on demand rather than replacing it.
 */

export const LIST_SKILLS_DEFINITION: ToolDefinition = {
  name: "list_skills",
  description:
    "List every skill visible to you (the tenant-shared library plus your own private skills). Returns a cheap index — only {id, name, displayName} per skill, never the skill body. Use this to discover what skills exist, then load_skill to read one. Read-only.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const SEARCH_SKILLS_DEFINITION: ToolDefinition = {
  name: "search_skills",
  description:
    "Search the skills visible to you by a free-text query, matched as a case-insensitive substring against each skill's name, display name, and description. Returns the same cheap index shape as list_skills ({id, name, displayName}) — never the skill body. If a search comes up empty, retry with different wording (synonyms or broader terms) before concluding no skill fits. Use load_skill to read a match. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search text matched as a case-insensitive substring against skill name, display name, and description.",
      },
    },
    required: ["query"],
  },
};

export const LOAD_SKILL_DEFINITION: ToolDefinition = {
  name: "load_skill",
  description:
    "Load the full content of one skill by its id (from list_skills or search_skills). Returns the SKILL.md body with its frontmatter stripped, plus the contents of any sibling files. Large content is truncated and binary files are omitted (each flagged), with a top-level notice when anything was dropped. Only skills visible to you can be loaded; an id you cannot see is reported as not found. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The skill id to load, as returned by list_skills or search_skills.",
      },
    },
    required: ["id"],
  },
};

export const LIST_SKILL_DRAFTS_DEFINITION: ToolDefinition = {
  name: "list_skill_drafts",
  description:
    "List your pending skill drafts — the ones awaiting your review under Skills → Pending drafts, not yet published. Returns a cheap index — only {id, name, description} per draft, never the SKILL.md body. Use this to find a draft to iterate on, then load_skill_draft to read it and skill_draft to save an improved version. Read-only.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const LOAD_SKILL_DRAFT_DEFINITION: ToolDefinition = {
  name: "load_skill_draft",
  description:
    "Load the full content of one of your pending skill drafts by its id (from list_skill_drafts). Returns the SKILL.md body, the contents of any support files, and existingSkillId (the id of the published skill this draft revises, or null for a new skill). Large content is truncated (flagged), with a top-level notice when anything was dropped. Only your own pending drafts can be loaded; an id you do not own, or one that is no longer pending, is reported as not found. To save changes, call skill_draft with the same name. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The draft id to load, as returned by list_skill_drafts.",
      },
    },
    required: ["id"],
  },
};

export const DRAFT_SKILL_DEFINITION: ToolDefinition = {
  name: "skill_draft",
  description:
    "Create or update a pending skill draft (as a skill-draft artifact). Takes a stable name, optional description, the full SKILL.md body, and optional support files. Returns {draftId, version}. Drafts are NOT published — the human owner reviews and approves them under Skills → Pending drafts in the workbench UI. Tell the user that is where to open the draft. Drafts are deduplicated by principal+name.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Stable skill identifier (used for the draft title and later asset name).",
      },
      description: {
        type: "string",
        description:
          "Short purpose/description of the skill (stored with the draft).",
      },
      body: {
        type: "string",
        description:
          "Complete SKILL.md content (including frontmatter if used).",
      },
      files: {
        type: "array",
        description: "Optional additional support files for the skill.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      existingSkillId: {
        type: "string",
        description:
          "When revising an existing skill, its id (for later replace/new-version).",
      },
    },
    required: ["name", "body"],
  },
};

export const SKILL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  LIST_SKILLS_DEFINITION,
  SEARCH_SKILLS_DEFINITION,
  LOAD_SKILL_DEFINITION,
  LIST_SKILL_DRAFTS_DEFINITION,
  LOAD_SKILL_DRAFT_DEFINITION,
  DRAFT_SKILL_DEFINITION,
];

const SearchSkillsArgs = type({ query: "string > 0" });
const LoadSkillArgs = type({ id: "string > 0" });
const LoadSkillDraftArgs = type({ id: "string > 0" });
const DraftSkillArgs = type({
  name: "string > 0",
  description: "string?",
  body: "string > 0",
  "files?": type({ path: "string", content: "string" }).array(),
  "existingSkillId?": "string > 0",
});

/** Parse and validate the `search_skills` query argument at the tool boundary. */
export function parseSearchQuery(args: unknown): string {
  const parsed = SearchSkillsArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`search_skills: ${parsed.summary}`);
  }
  return parsed.query;
}

/** Parse and validate the `load_skill` id argument at the tool boundary. */
export function parseSkillId(args: unknown): string {
  const parsed = LoadSkillArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`load_skill: ${parsed.summary}`);
  }
  return parsed.id;
}

/** Parse and validate the `load_skill_draft` id argument at the tool boundary. */
export function parseSkillDraftId(args: unknown): string {
  const parsed = LoadSkillDraftArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`load_skill_draft: ${parsed.summary}`);
  }
  return parsed.id;
}

/** Parse and validate the `skill_draft` arguments at the tool boundary. */
export function parseDraftSkillArgs(args: unknown): {
  name: string;
  description?: string;
  body: string;
  files?: { path: string; content: string }[];
  existingSkillId?: string;
} {
  const parsed = DraftSkillArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`skill_draft: ${parsed.summary}`);
  }
  return parsed;
}

/** The cheap index entry returned by list_skills / search_skills (no body). */
export type SkillIndexEntry = {
  id: string;
  name: string;
  displayName: string | null;
  description?: string | null;
};

/**
 * Pure case-insensitive substring match over an index entry's name, display
 * name, and description. Matching the description widens recall so a skill can
 * be found by what it does, not only by its title. Shared by the hub handler
 * and tested directly so the filter contract is independent of any db.
 */
export function skillMatchesQuery(
  entry: SkillIndexEntry,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack =
    `${entry.name}\n${entry.displayName ?? ""}\n${entry.description ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}
