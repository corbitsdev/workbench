// The create-agent-definition request shape, validated at the REST
// boundary before anything touches the asset service.

import { type } from "arktype";
import { skillNameSchema } from "@corbits/skills";

// Mirrors `@intx/hub-sessions`' `ASSET_NAME_PATTERN` exactly (not
// imported: the constant is internal to that package). A definition's
// handle becomes its workflow asset's name, so it is bound by the same
// lowercase-kebab rule the asset service enforces at creation — failing
// here gives a specific, field-scoped error instead of a generic
// asset-service rejection three calls deeper.
const HANDLE_PATTERN = type(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A string that is non-blank once trimmed and at most `max` characters
 * untrimmed. Used for every free-text field a person types into the
 * create-agent form, so a whitespace-only submission reads as the same
 * "required" error a truly empty one would. */
function boundedNonBlankString(max: number) {
  return type("string").narrow((value, ctx) => {
    if (value.trim() === "") return ctx.mustBe("a non-blank string");
    if (value.length > max) return ctx.mustBe(`at most ${max} characters`);
    return true;
  });
}

// A pinned skill names a row in the tenant's skill registry
// (`@corbits/skills`), so it is bound by exactly the registry's own name
// rule — the same kebab-case, `<=64`-char shape the hub's `skill` kind
// handler requires of a SKILL.md's frontmatter. A name outside it could
// never resolve to a real skill, so rejecting it here beats storing a
// pin that silently indexes nothing.
const SkillNameArray = skillNameSchema.array().narrow((skills, ctx) => {
  const seen = new Set<string>();
  for (const name of skills) {
    if (seen.has(name))
      return ctx.mustBe(`a list without duplicate skill "${name}"`);
    seen.add(name);
  }
  return true;
});

// A pinned tool package names a `@corbits/*` workspace package, the only
// namespace this catalog ever resolves a pin against.
const ToolPackageNamePattern = type(/^@corbits\/[a-z0-9-]+$/);
const ToolPackagePinArray = ToolPackageNamePattern.array().narrow(
  (pins, ctx) => {
    const seen = new Set<string>();
    for (const name of pins) {
      if (seen.has(name))
        return ctx.mustBe(`a list without duplicate tool package "${name}"`);
      seen.add(name);
    }
    return true;
  },
);

export const CreateAgentDefinitionInput = type({
  name: boundedNonBlankString(100),
  handle: HANDLE_PATTERN.describe(
    "lowercase letters, digits, and hyphens only, no leading or trailing hyphen",
  ),
  "description?": type("string <= 500"),
  systemPrompt: boundedNonBlankString(8000),
  "model?": boundedNonBlankString(200),
  "skills?": SkillNameArray,
  // `toolPackagePins` names tool packages by name only (no version — the
  // core resolves each to `*`, matching `./workflow-create-routes.ts`'s
  // own handling of the same field). Absent for a person hand-authoring
  // an agent through a form, which has no affordance for typing one; the
  // one caller that supplies it is `@corbits/workflow-catalog`'s
  // `instantiateWorkbenchTemplate`, installing a template participant
  // (Scout, Jimmy) whose tools ship as pinned packages rather than
  // inline capabilities.
  "toolPackagePins?": ToolPackagePinArray,
});
export type CreateAgentDefinitionInput =
  typeof CreateAgentDefinitionInput.infer;

/** The body of a request that replaces a definition's attached skills
 * wholesale — an empty array clears every attachment, never a partial
 * patch, so the client always states the full set it wants. */
export const UpdateAgentSkillsInput = type({
  skills: SkillNameArray,
});
export type UpdateAgentSkillsInput = typeof UpdateAgentSkillsInput.infer;

/** The body of a request that replaces a definition's display name and
 * system prompt wholesale — the Assistant settings section's edit
 * form, mirroring `CreateAgentDefinitionInput`'s `name`/`systemPrompt`
 * fields exactly (the create form's "name" is this same display name). */
export const UpdateAgentInstructionsInput = type({
  name: boundedNonBlankString(100),
  systemPrompt: boundedNonBlankString(8000),
});
export type UpdateAgentInstructionsInput =
  typeof UpdateAgentInstructionsInput.infer;

/** The body of a request that moves a definition between the two
 * lifecycle states the schema knows: `deployed` (launchable, listed
 * everywhere a person can start a chat) and `stopped` — what the agent
 * detail page's "Archive" writes. Never a delete: the definition, its
 * asset, and its history all stay intact, so restoring it is one write
 * back to `deployed`. */
export const UpdateDefinitionStatusInput = type({
  status: "'deployed' | 'stopped'",
});
export type UpdateDefinitionStatusInput =
  typeof UpdateDefinitionStatusInput.infer;

/** The body of a request that restores a definition to an earlier
 * commit on its own asset history — the same `commitSha` shape
 * `@corbits/skills`' restore route takes, kept plain-text ("history",
 * never "commit SHA") everywhere a person reads it; the sha only
 * appears in a tooltip. */
export const RestoreDefinitionInput = type({ commitSha: "string > 0" });
export type RestoreDefinitionInput = typeof RestoreDefinitionInput.infer;
