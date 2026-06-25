// Native `interchange.tools` entry for @workbench/tools-skills.
//
// All three tools resolve hub-owned tables and the asset git store, so this is
// a hub-backed package: the factory carries the tool definitions and forwards
// each call to the hub's scoped `/api/internal/hub-tools/run` endpoint.

import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { SKILL_TOOL_DEFINITIONS } from "./index";

export const skills = defineHubBackedToolPackage({
  id: "@workbench/tools-skills/skills",
  definitions: SKILL_TOOL_DEFINITIONS,
});
