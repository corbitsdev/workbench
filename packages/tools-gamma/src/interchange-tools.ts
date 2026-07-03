import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
} from "@workbench/tool-credentials/factory";
import { GAMMA_HUB_TOOLS, GAMMA_LIST_TEMPLATES_DEFINITION } from "./index";

export const gamma = defineCredentialedToolPackage({
  id: "@workbench/tools-gamma/gamma",
  provider: "gamma",
  entries: GAMMA_HUB_TOOLS,
});

// gamma_list_templates reads tenant-owned templates from the hub DB rather
// than calling the Gamma API (which has no list-templates endpoint), so it is
// a hub-backed factory: it requires the hub-RPC env key instead of the gamma
// credential and is reachable by both live agent sessions and workflow steps
// via the manifest/step-tool-harness rail. Execution lives in
// apps/hub/src/tools/gamma-templates.ts (HUB_BACKED_TOOLS).
export const gammaTemplates = defineHubBackedToolPackage({
  id: "@workbench/tools-gamma/gamma-templates",
  definitions: [GAMMA_LIST_TEMPLATES_DEFINITION],
});
