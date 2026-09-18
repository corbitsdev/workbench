// Bounds `toolPackagePins` the way `./validation.ts` bounds every other
// list field a create-agent request carries. `CreateAgentDefinitionInput`
// has no field for this, so this package owns the bound itself.

import { type } from "arktype";

const MAX_TOOL_PACKAGE_PINS = 8;

/** A deduped array of at most `MAX_TOOL_PACKAGE_PINS` tool package names. */
export const BoundedDedupedToolPackageNameArray = type("string[]").narrow((names, ctx) => {
  if (names.length > MAX_TOOL_PACKAGE_PINS) {
    return ctx.mustBe(`at most ${MAX_TOOL_PACKAGE_PINS} tool package pins`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      return ctx.mustBe(`a list without duplicate tool package "${name}"`);
    }
    seen.add(name);
  }
  return true;
});
