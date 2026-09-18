// The create-agent-definition request shape, validated at the REST
// boundary before anything touches the asset service.

import { type } from "arktype";
import { skillNameSchema } from "@corbits/skills-tools";

// Mirrors `@intx/hub-sessions`' internal asset-name pattern, so a bad
// handle fails here with a field-scoped error, not a generic rejection
// three calls deeper.
const HANDLE_PATTERN = type(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A string that is non-blank once trimmed and at most `max` characters
 * untrimmed, so a whitespace-only submission reads as required too. */
function boundedNonBlankString(max: number) {
  return type("string").narrow((value, ctx) => {
    if (value.trim() === "") return ctx.mustBe("a non-blank string");
    if (value.length > max) return ctx.mustBe(`at most ${max} characters`);
    return true;
  });
}

// A pinned skill name must match the registry's own naming rule — a name
// outside it could never resolve to a real skill.
const SkillNameArray = skillNameSchema.array().narrow((skills, ctx) => {
  const seen = new Set<string>();
  for (const name of skills) {
    if (seen.has(name)) return ctx.mustBe(`a list without duplicate skill "${name}"`);
    seen.add(name);
  }
  return true;
});

// A pinned tool package names a `@corbits/*` workspace package, the only
// namespace this catalog ever resolves a pin against.
const ToolPackageNamePattern = type(/^@corbits\/[a-z0-9-]+$/);
const ToolPackagePinArray = ToolPackageNamePattern.array().narrow((pins, ctx) => {
  const seen = new Set<string>();
  for (const name of pins) {
    if (seen.has(name)) return ctx.mustBe(`a list without duplicate tool package "${name}"`);
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
  // Names tool packages by name only — the core resolves each to `*`.
  // Absent for a hand-authored form submission.
  "toolPackagePins?": ToolPackagePinArray,
});
export type CreateAgentDefinitionInput = typeof CreateAgentDefinitionInput.infer;

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
export type UpdateAgentInstructionsInput = typeof UpdateAgentInstructionsInput.infer;

/** Moves a definition between `deployed` and `stopped`. Never a delete —
 * restoring is one write back to `deployed`. */
export const UpdateDefinitionStatusInput = type({
  status: "'deployed' | 'stopped'",
});
export type UpdateDefinitionStatusInput = typeof UpdateDefinitionStatusInput.infer;

/** Restores a definition to an earlier commit on its own asset history. */
export const RestoreDefinitionInput = type({ commitSha: "string > 0" });
export type RestoreDefinitionInput = typeof RestoreDefinitionInput.infer;
