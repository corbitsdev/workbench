// CL-7543 follow-up: the planner's one-shot runner and the webhook
// launch path must both consult the hub's live sidecar routing table
// through the shared `isSidecarRoutable` local. A regression replacing
// either wiring with a constant (`() => true`) or dropping the hoisted
// predicate would still typecheck; this source scan is the pin, in the
// same style as `crypto-provider-cache-wiring.test.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const HUB_INDEX = path.join(import.meta.dir, "index.ts");

/** The full `callee(...)` text of the first call in `source`. */
function firstCall(source: string, callee: string): string {
  const token = `${callee}(`;
  const start = source.indexOf(token);
  if (start < 0) {
    throw new Error(`expected ${callee}(...) in hub index.ts`);
  }
  let depth = 1;
  let i = start + token.length;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return source.slice(start, i);
}

describe("hub sidecar routability wiring", () => {
  test("one shared isSidecarRoutable predicate feeds both launch paths", () => {
    const source = readFileSync(HUB_INDEX, "utf8");

    const assigned =
      /const\s+isSidecarRoutable\s*=\s*\(address:\s*string\)\s*=>\s*\n?\s*sidecarRouter\.getRoutableAddresses\(\)\.includes\(address\)/.exec(
        source,
      );
    expect(assigned).not.toBeNull();

    // Exactly one definition: no second, diverging routability source.
    const definitionCount = source.match(
      /getRoutableAddresses\(\)\.includes\(/g,
    );
    expect(definitionCount).toHaveLength(1);

    expect(firstCall(source, "runOneShotPrompt")).toContain(
      "isRoutable: isSidecarRoutable",
    );
    expect(firstCall(source, "launchWebhookTrigger")).toContain(
      "isRoutable: isSidecarRoutable",
    );
  });
});
