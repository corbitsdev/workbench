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
    "Search the skills visible to you by a free-text query, matched as a case-insensitive substring against each skill name and display name. Returns the same cheap index shape as list_skills ({id, name, displayName}) — never the skill body. Use load_skill to read a match. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search text matched as a case-insensitive substring against skill name and display name.",
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

export const SKILL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  LIST_SKILLS_DEFINITION,
  SEARCH_SKILLS_DEFINITION,
  LOAD_SKILL_DEFINITION,
];

const SearchSkillsArgs = type({ query: "string > 0" });
const LoadSkillArgs = type({ id: "string > 0" });

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

/** The cheap index entry returned by list_skills / search_skills (no body). */
export type SkillIndexEntry = {
  id: string;
  name: string;
  displayName: string | null;
};

/**
 * Pure case-insensitive substring match over an index entry's name and display
 * name. Shared by the hub handler and tested directly so the filter contract is
 * independent of any db.
 */
export function skillMatchesQuery(
  entry: SkillIndexEntry,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = `${entry.name}\n${entry.displayName ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}
