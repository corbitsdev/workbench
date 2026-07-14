import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { fetchLinearGraphQL } from "./client";
import { LINEAR_DEFINITIONS, LINEAR_HUB_TOOLS } from "./hub-tools";
import { validateConfig, type LinearToolsConfig } from "./shared";
import { createLinearToolFor } from "./tool-runtime";


export type { LinearFetch, LinearToolsConfig } from "./shared";
export { fetchLinearGraphQL } from "./client";
export { LINEAR_DEFINITIONS, LINEAR_HUB_TOOLS } from "./hub-tools";

export {
  LINEAR_LIST_ISSUES_DEFINITION,
  LINEAR_GET_ISSUE_DEFINITION,
  LINEAR_CREATE_ISSUE_DEFINITION,
  LINEAR_UPDATE_ISSUE_DEFINITION,
  LINEAR_ARCHIVE_ISSUE_DEFINITION,
  LINEAR_DELETE_ISSUE_DEFINITION,
  LINEAR_LINK_ISSUES_DEFINITION,
  listIssues,
  getIssue,
  createIssue,
} from "./issues";

export {
  LINEAR_LIST_TEAMS_DEFINITION,
  LINEAR_GET_TEAM_DEFINITION,
  listTeams,
} from "./teams";

export {
  LINEAR_LIST_USERS_DEFINITION,
  LINEAR_GET_USER_DEFINITION,
  listUsers,
} from "./users";

export function createLinearTools(config: LinearToolsConfig): AgentTool[] {
  validateConfig(config);
  return Object.values(LINEAR_HUB_TOOLS).flatMap((entry) =>
    createLinearToolFor(config, entry.definition, entry.handler),
  );
}

export function createLinearToolByName(
  config: LinearToolsConfig,
  name: string,
): AgentTool[] {
  validateConfig(config);
  const entry = LINEAR_HUB_TOOLS[name];
  if (entry === undefined) {
    return [];
  }
  return entry.createTools({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? "",
  });
}