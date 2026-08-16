// Drift guard (CL-6092): chat-ui's inference-failure.ts hand-copies the
// two preambles vendor/intx/inference's formatInferenceError writes for
// credential_failure and quota_exhausted. Nothing else ties the copies
// together — this test fails the moment the vendored source's wording
// changes, instead of the "Fix this connection" affordance silently
// vanishing. See inference-failure.ts's own module comment for why this
// stays a prose match rather than a structured read: a reply reaches the
// chat timeline as a plain `text` part with no metadata by the time this
// module ever sees it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLASSIFIED_INFERENCE_FAILURE_PREAMBLES } from "../src/inference-failure";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

test("chat-ui's classified-failure preambles match the vendored director's exact strings", () => {
  const director = readFileSync(
    join(REPO_ROOT, "vendor/intx/inference/src/default-director.ts"),
    "utf8",
  );
  for (const preamble of CLASSIFIED_INFERENCE_FAILURE_PREAMBLES) {
    expect(director).toContain(`"${preamble}"`);
  }
});
