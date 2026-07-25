// Native `interchange.tools` entry for @workbench/tools-sumble-account-intel.
//
// Declares the `sumble` tool credential as a `requires` env key — this
// factory calls @workbench/tools-sumble's exported factory function
// directly, in-process (see tools.ts), rather than pinning that package's
// own factory. The sidecar's step-tool-harness resolves a factory's
// declared `requires` env keys the same way regardless of which package
// declares them (`apps/sidecar/src/step-tool-harness.ts` `buildStepTools`
// walks every PINNED factory's own `requires`), so this factory's
// credential requirement is satisfied exactly as @workbench/tools-sumble's
// own factory would be — no separate pin of that package is needed.
//
// `xai` is deliberately NOT resolved here (a correctness fix): it
// backs only the best-effort `enrich-contacts` facet inside tools.ts, which
// resolves it lazily inside its own handler and degrades per-contact when
// missing. Resolving `xai` eagerly in this factory — as the original wiring
// did — would throw `ToolCredentialMissingError` for the WHOLE package (not
// just enrich-contacts) whenever a tenant has no xAI credential configured,
// dropping the genuinely-required `resolve`/`search_people`/facet tools too.
// `sumble` stays eager: `resolve`/`search_people` are documented fatal, so
// the workflow cannot function at all without it — no degrade to preserve.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  getToolCredential,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import { createSumbleAccountIntelTools } from "./tools";

export const sumbleAccountIntel = defineTool({
  id: "@workbench/tools-sumble-account-intel/core",
  requires: [toolCredentialEnvKey("sumble"), toolCredentialEnvKey("xai")],
  factory: (env) => {
    const record = env as unknown as Record<string, unknown>;
    const sumbleCredential = getToolCredential(record, "sumble");
    return createToolRunner(
      createSumbleAccountIntelTools(
        {
          sumble: {
            apiKey: sumbleCredential.apiKey,
            baseUrl: sumbleCredential.baseURL,
          },
        },
        record,
      ),
    );
  },
});
