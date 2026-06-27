// Native `interchange.tools` entry for @workbench/tools-agents.
//
// Both the principal directory (list_principals) and the agent directory
// (list_agents) resolve hub-owned tables, so this is a hub-backed package:
// the factory carries the tool definitions and forwards each call to the
// hub's scoped `/api/internal/hub-tools/run` endpoint.

import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { LIST_AGENTS_DEFINITION, LIST_PRINCIPALS_DEFINITION } from "./index";
import { IDENTITY_GET_DEFINITION, IDENTITY_SET_DEFINITION } from "./identity";

export const agents = defineHubBackedToolPackage({
  id: "@workbench/tools-agents/agents",
  definitions: [
    LIST_PRINCIPALS_DEFINITION,
    LIST_AGENTS_DEFINITION,
    IDENTITY_GET_DEFINITION,
    IDENTITY_SET_DEFINITION,
  ],
});
