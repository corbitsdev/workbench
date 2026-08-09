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

export const CreateAgentDefinitionInput = type({
  name: boundedNonBlankString(100),
  handle: HANDLE_PATTERN.describe(
    "lowercase letters, digits, and hyphens only, no leading or trailing hyphen",
  ),
  "description?": type("string <= 500"),
  systemPrompt: boundedNonBlankString(8000),
  "model?": boundedNonBlankString(200),
});
export type CreateAgentDefinitionInput =
  typeof CreateAgentDefinitionInput.infer;
