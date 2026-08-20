// Drift guard (CL-6092): chat-ui's inference-failure.ts hand-copies the
// two preambles @intx/inference's formatInferenceError writes for
// credential_failure and quota_exhausted. Nothing else ties the copies
// together — this test fails the moment the published director's wording
// changes, instead of the "Fix this connection" affordance silently
// vanishing. See inference-failure.ts's own module comment for why this
// stays a prose match rather than a structured read: a reply reaches the
// chat timeline as a plain `text` part with no metadata by the time this
// module ever sees it. The published package ships compiled dist only,
// so the guard reads the compiled director — the string literals survive
// compilation verbatim.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLASSIFIED_INFERENCE_FAILURE_PREAMBLES } from "../src/inference-failure";

test("chat-ui's classified-failure preambles match the published director's exact strings", () => {
  const distDir = dirname(
    fileURLToPath(import.meta.resolve("@intx/inference")),
  );
  const director = readFileSync(join(distDir, "default-director.js"), "utf8");
  for (const preamble of CLASSIFIED_INFERENCE_FAILURE_PREAMBLES) {
    expect(director).toContain(`"${preamble}"`);
  }
});
