// Native `interchange.tools` entry for @workbench/tools-artifact.
//
// Artifact tools execute hub-side (they write the hub's artifact tables),
// so this is a hub-backed package: the factory carries only the tool
// definitions and forwards every call to the hub's scoped
// `/api/internal/hub-tools/run` endpoint via the injected hub-RPC context.

import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { ARTIFACT_TOOL_DEFINITIONS } from "./definitions";

export const artifact = defineHubBackedToolPackage({
  id: "@workbench/tools-artifact/artifact",
  definitions: ARTIFACT_TOOL_DEFINITIONS,
});
