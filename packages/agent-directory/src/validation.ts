// The create-agent-definition request shape, validated at the REST
// boundary before anything touches the asset service.

import { type } from "arktype";

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

// Not constrained to `@intx/hub-sessions`' skill-kind frontmatter name
// pattern (kebab-case, `<=64` chars): there is no hub skill registry a
// person can attach from yet (see `../../../apps/web/src/skills-session.ts`),
// so a "skill" a definition carries today is whatever free-text name that
// session-local registry gave it. Once a real skill registry exists this
// should tighten to match its name rule — tracked as a known follow-up,
// not silently worked around.
const SkillName = boundedNonBlankString(100);

const SkillNameArray = SkillName.array().narrow((skills, ctx) => {
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
