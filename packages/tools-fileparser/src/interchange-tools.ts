// Native `interchange.tools` entry for @workbench/tools-fileparser.
//
// parse_file executes hub-side (it reads the hub artifact tables and runs an
// in-hub Anthropic inference turn), so this is a hub-backed package: the factory
// carries only the tool definition and forwards every call to the hub's scoped
// `/api/internal/hub-tools/run` endpoint via the injected hub-RPC context.

import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { FILEPARSER_TOOL_DEFINITIONS } from "./definitions";

export const fileparser = defineHubBackedToolPackage({
  id: "@workbench/tools-fileparser/fileparser",
  definitions: FILEPARSER_TOOL_DEFINITIONS,
});
