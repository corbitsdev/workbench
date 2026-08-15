// Bounds the `{create}` branch's `toolPackagePins` the same way
// `@corbits/agent-directory`'s `validation.ts` bounds every other
// free-text/list field a create-agent request carries. That REST
// boundary's own `CreateAgentDefinitionInput` has no `toolPackagePins`
// field at all (see its own comment: no UI affordance ever sends one
// through that route today), so this is the one bound this package
// must own itself rather than reuse — everything else `spawnFromTaskSpec`
// validates before deploying reuses `CreateAgentDefinitionInput`
// directly.

import { type } from "arktype";

const MAX_TOOL_PACKAGE_PINS = 8;

/** A deduped array of at most `MAX_TOOL_PACKAGE_PINS` tool package
 * names, mirroring `@corbits/agent-directory`'s `validation.ts`
 * `SkillNameArray`'s own dedup-check style exactly. */
export const BoundedDedupedToolPackageNameArray = type("string[]").narrow(
  (names, ctx) => {
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
  },
);
