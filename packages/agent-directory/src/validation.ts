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

export const CreateAgentDefinitionInput = type({
  name: boundedNonBlankString(100),
  handle: HANDLE_PATTERN.describe(
    "lowercase letters, digits, and hyphens only, no leading or trailing hyphen",
  ),
  "description?": type("string <= 500"),
  systemPrompt: boundedNonBlankString(8000),
  "model?": boundedNonBlankString(200),
  "skills?": SkillNameArray,
  // No `toolPackagePins` field, deliberately: this is the HTTP route
  // for a person hand-authoring an agent through a form, which has no
  // affordance for typing an arbitrary tool-package pin. The one
  // caller that needs `buildAgentDefinitionWorkflow`'s optional
  // `toolPackagePins` (CL-6051's `{create}` planner branch, see
  // `@corbits/task-planner`) calls that builder directly, in-process,
  // never through this REST boundary — so parity here isn't needed
  // unless a future UI grows a "pin a tool package" field of its own.
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
