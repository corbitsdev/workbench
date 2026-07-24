import { type AgentTool, stringTool, tool } from "@intx/agent";

import * as definitions from "./definitions";
import * as handlers from "./handlers";
import { validateConfig } from "./shared";
import type { SumbleToolSpec, SumbleToolsConfig } from "./types";

export const SUMBLE_TOOL_SPECS: SumbleToolSpec[] = [
  {
    definition: definitions.SUMBLE_RESOLVE_ORGANIZATION_DEFINITION,
    kind: "structured",
    sideEffect: "read",
    run: handlers.resolveOrganization,
  },
  {
    definition: definitions.SUMBLE_SEARCH_ORGANIZATIONS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.searchOrganizations,
  },
  {
    definition: definitions.SUMBLE_GET_ORG_TECH_STACK_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.getOrgTechStack,
  },
  {
    definition: definitions.SUMBLE_LIST_TEAMS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.listTeams,
  },
  {
    definition: definitions.SUMBLE_SEARCH_PEOPLE_DEFINITION,
    kind: "structured",
    sideEffect: "read",
    run: handlers.searchPeople,
  },
  {
    definition: definitions.SUMBLE_LIST_JOBS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.listJobs,
  },
  {
    definition: definitions.SUMBLE_SEARCH_SIGNALS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.searchSignals,
  },
  {
    definition: definitions.SUMBLE_GET_INTELLIGENCE_BRIEF_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.getIntelligenceBrief,
  },
  {
    definition: definitions.SUMBLE_GET_ORGANIZATION_SIGNALS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.getOrganizationSignals,
  },
  {
    definition: definitions.SUMBLE_SEARCH_PRIORITY_SIGNALS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.searchPrioritySignals,
  },
  {
    definition: definitions.SUMBLE_LOOKUP_JOB_TITLES_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.lookupJobTitles,
  },
  {
    definition: definitions.SUMBLE_LOOKUP_PROJECTS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.lookupProjects,
  },
  {
    definition: definitions.SUMBLE_LOOKUP_TECHNOLOGIES_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.lookupTechnologies,
  },
  {
    definition: definitions.SUMBLE_FIND_TECHNOLOGIES_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.findTechnologies,
  },
  {
    definition: definitions.SUMBLE_LOOKUP_TECHNOLOGY_CATEGORIES_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.lookupTechnologyCategories,
  },
  {
    definition: definitions.SUMBLE_POST_ORGANIZATIONS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.postOrganizations,
  },
  {
    definition: definitions.SUMBLE_POST_TEAMS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.postTeams,
  },
  {
    definition: definitions.SUMBLE_POST_PEOPLE_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.postPeople,
  },
  {
    definition: definitions.SUMBLE_POST_JOBS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.postJobs,
  },
  {
    definition: definitions.SUMBLE_POST_SIGNALS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.postSignals,
  },
  {
    definition: definitions.SUMBLE_LIST_CONTACT_LISTS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.listContactLists,
  },
  {
    definition: definitions.SUMBLE_GET_CONTACT_LIST_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.getContactList,
  },
  {
    definition: definitions.SUMBLE_CREATE_CONTACT_LIST_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.createContactList,
  },
  {
    definition: definitions.SUMBLE_ADD_CONTACT_LIST_PEOPLE_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.addContactListPeople,
  },
  {
    definition: definitions.SUMBLE_LIST_ORGANIZATION_LISTS_DEFINITION,
    kind: "string",
    sideEffect: "read",
    run: handlers.listOrganizationLists,
  },
  {
    // Consumed by prospect-engine's deterministic list-read steps
    // (sumble_get_organization_list); structured so the downstream
    // extract-list-org-ids step reads fields off `content` directly.
    definition: definitions.SUMBLE_GET_ORGANIZATION_LIST_DEFINITION,
    kind: "structured",
    sideEffect: "read",
    run: handlers.getOrganizationList,
  },
  {
    definition: definitions.SUMBLE_CREATE_ORGANIZATION_LIST_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.createOrganizationList,
  },
  {
    // Consumed by prospect-engine's deterministic list-write steps
    // (sumble_add_organization_list_organizations); structured for the
    // same reason as sumble_get_organization_list above.
    definition:
      definitions.SUMBLE_ADD_ORGANIZATION_LIST_ORGANIZATIONS_DEFINITION,
    kind: "structured",
    sideEffect: "write",
    run: handlers.addOrganizationListOrganizations,
  },
  {
    definition: definitions.SUMBLE_SET_ORGANIZATION_LIST_DELETED_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.setOrganizationListDeleted,
  },
  {
    definition: definitions.SUMBLE_SET_ORGANIZATION_LIST_SIGNALS_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.setOrganizationListSignals,
  },
  {
    definition: definitions.SUMBLE_CREATE_SUPPORT_REQUEST_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.createSupportRequest,
  },
  {
    definition: definitions.SUMBLE_CREATE_DATA_QUALITY_REPORT_DEFINITION,
    kind: "string",
    sideEffect: "write",
    run: handlers.createDataQualityReport,
  },
];

function createSumbleToolFor(
  config: SumbleToolsConfig,
  spec: SumbleToolSpec,
): AgentTool {
  validateConfig(config);
  if (spec.kind === "structured") {
    return tool({
      definition: spec.definition,
      async handler(call, signal) {
        const result = await spec.run(config, call.arguments, signal);
        return {
          callId: call.id,
          content: result as Record<string, unknown>,
        };
      },
    });
  }
  return stringTool({
    definition: spec.definition,
    async handler(args, signal) {
      return (await spec.run(config, args, signal)) as string;
    },
  });
}

export function createSumbleTools(config: SumbleToolsConfig): AgentTool[] {
  return SUMBLE_TOOL_SPECS.map((spec) => createSumbleToolFor(config, spec));
}

export const SUMBLE_HUB_TOOLS = Object.fromEntries(
  SUMBLE_TOOL_SPECS.map((spec) => [
    spec.definition.name,
    {
      sideEffect: spec.sideEffect,
      definition: spec.definition,
      providerName: "sumble",
      createTools: (config: { apiKey: string; baseURL: string }) => [
        createSumbleToolFor(
          {
            apiKey: config.apiKey,
            ...(config.baseURL.length > 0 ? { baseUrl: config.baseURL } : {}),
          },
          spec,
        ),
      ],
    },
  ]),
);
