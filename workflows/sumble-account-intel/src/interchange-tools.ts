// Native `interchange.tools` entry for @workbench/tools-sumble-account-intel.
//
// Declares BOTH the `sumble` and `xai` tool credentials as `requires` env
// keys — this factory calls @workbench/tools-sumble's and @workbench/tools-x's
// exported factory functions directly, in-process (see tools.ts), rather than
// pinning those packages' own factories. The sidecar's step-tool-harness
// resolves a factory's declared `requires` env keys the same way regardless
// of which package declares them (`apps/sidecar/src/step-tool-harness.ts`
// `buildStepTools` walks every PINNED factory's own `requires`), so this
// factory's two credential requirements are satisfied exactly as
// @workbench/tools-sumble's and @workbench/tools-x's own factories would be —
// no separate pin of those packages is needed.

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
    const xCredential = getToolCredential(record, "xai");
    return createToolRunner(
      createSumbleAccountIntelTools({
        sumble: {
          apiKey: sumbleCredential.apiKey,
          baseUrl: sumbleCredential.baseURL,
        },
        x: {
          apiKey: xCredential.apiKey,
          baseURL: xCredential.baseURL,
        },
      }),
    );
  },
});
