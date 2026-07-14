import type { ToolDefinition } from "@intx/types/runtime";

function objectTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
  };
}

export const SUMBLE_RESOLVE_ORGANIZATION_DEFINITION = objectTool(
  "sumble_resolve_organization",
  "Resolve a company to its Sumble organization (v9 POST /organizations match mode). Returns core attributes including slug and id as a structured object.",
  {
    identifier: { type: "string" },
    domain: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
  },
);

export const SUMBLE_SEARCH_ORGANIZATIONS_DEFINITION = objectTool(
  "sumble_search_organizations",
  "Search organizations via v9 POST /organizations filter mode (query, industry, employee range).",
  {
    query: { type: "string" },
    industry: { type: "string" },
    minEmployees: { type: "number" },
    maxEmployees: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
);

export const SUMBLE_GET_ORG_TECH_STACK_DEFINITION = objectTool(
  "sumble_get_org_tech_stack",
  "Read technology signals per team via v9 POST /teams (technology_list on each team).",
  {
    identifier: { type: "string" },
    domain: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    limit: { type: "number" },
  },
);

export const SUMBLE_LIST_TEAMS_DEFINITION = objectTool(
  "sumble_list_teams",
  "List teams for an organization via v9 POST /teams filter mode.",
  {
    organizationSlug: { type: "string" },
    organizationId: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
  ["organizationSlug"],
);

export const SUMBLE_SEARCH_PEOPLE_DEFINITION = objectTool(
  "sumble_search_people",
  "Find people via v9 POST /people (async polled). Returns structured { people, count }.",
  {
    organizationSlug: { type: "string" },
    organizationId: { type: "number" },
    email: { type: "string" },
    linkedinUrl: { type: "string" },
    personId: { type: "number" },
    title: { type: "string" },
    revealEmail: { type: "boolean" },
    confirmEmailRevealSpend: { type: "boolean" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
);

export const SUMBLE_LIST_JOBS_DEFINITION = objectTool(
  "sumble_list_jobs",
  "List job posts for an organization via v9 POST /jobs filter mode.",
  {
    organizationSlug: { type: "string" },
    organizationId: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
  ["organizationSlug"],
);

export const SUMBLE_SEARCH_SIGNALS_DEFINITION = objectTool(
  "sumble_search_signals",
  "Search signals across accounts via v9 POST /signals.",
  {
    organizationSlug: { type: "string" },
    organizationId: { type: "number" },
    technologySlugs: { type: "array", items: { type: "string" } },
    jobFunctions: { type: "array", items: { type: "string" } },
    priorities: { type: "array", items: { type: "string" } },
    personIds: { type: "array", items: { type: "number" } },
    signalIds: { type: "array", items: { type: "number" } },
    accountListIds: { type: "array", items: { type: "number" } },
    limit: { type: "number" },
  },
);

export const SUMBLE_GET_INTELLIGENCE_BRIEF_DEFINITION = objectTool(
  "sumble_get_intelligence_brief",
  "Generate an intelligence brief via v9 GET /organizations/{organization_id}/intelligence-brief. Costs 50 credits; requires confirmSpend: true.",
  {
    organizationSlug: { type: "string" },
    organizationId: { type: "number" },
    confirmSpend: { type: "boolean" },
  },
);

export const SUMBLE_GET_ORGANIZATION_SIGNALS_DEFINITION = objectTool(
  "sumble_get_organization_signals",
  "Signals for one organization via v9 GET /organizations/{organization_id}/signals.",
  {
    organizationSlug: { type: "string" },
    organizationId: { type: "number" },
    technologySlugs: { type: "array", items: { type: "string" } },
  },
);

export const SUMBLE_SEARCH_PRIORITY_SIGNALS_DEFINITION = objectTool(
  "sumble_search_priority_signals",
  "Priority Signals digest via v9 POST /signals/priority. Pass the full request body.",
  { body: { type: "object" } },
  ["body"],
);

export const SUMBLE_LOOKUP_JOB_TITLES_DEFINITION = objectTool(
  "sumble_lookup_job_titles",
  "Map job titles to function and level via v9 POST /jobs/title-lookup.",
  { titles: { type: "array", items: { type: "string" } } },
  ["titles"],
);

export const SUMBLE_LOOKUP_PROJECTS_DEFINITION = objectTool(
  "sumble_lookup_projects",
  "Look up projects by name via v9 POST /projects/lookup.",
  { terms: { type: "array", items: { type: "string" } } },
  ["terms"],
);

export const SUMBLE_LOOKUP_TECHNOLOGIES_DEFINITION = objectTool(
  "sumble_lookup_technologies",
  "Resolve technology names/slugs/aliases via v9 POST /technologies/lookup.",
  { terms: { type: "array", items: { type: "string" } } },
  ["terms"],
);

export const SUMBLE_FIND_TECHNOLOGIES_DEFINITION = objectTool(
  "sumble_find_technologies",
  "Search technologies by name via v9 POST /technologies/find.",
  { terms: { type: "array", items: { type: "string" } } },
  ["terms"],
);

export const SUMBLE_LOOKUP_TECHNOLOGY_CATEGORIES_DEFINITION = objectTool(
  "sumble_lookup_technology_categories",
  "Look up technology categories via v9 POST /technologies/categories/lookup.",
  { terms: { type: "array", items: { type: "string" } } },
  ["terms"],
);

export const SUMBLE_POST_ORGANIZATIONS_DEFINITION = objectTool(
  "sumble_post_organizations",
  "Full v9 POST /organizations request (match or filter). Pass the API body verbatim.",
  { body: { type: "object" } },
  ["body"],
);

export const SUMBLE_POST_TEAMS_DEFINITION = objectTool(
  "sumble_post_teams",
  "Full v9 POST /teams request. Pass the API body verbatim.",
  { body: { type: "object" } },
  ["body"],
);

export const SUMBLE_POST_PEOPLE_DEFINITION = objectTool(
  "sumble_post_people",
  "Full v9 POST /people request (async polled). Pass the API body verbatim. Email/phone in select requires confirmEmailRevealSpend.",
  {
    body: { type: "object" },
    confirmEmailRevealSpend: { type: "boolean" },
  },
);

export const SUMBLE_POST_JOBS_DEFINITION = objectTool(
  "sumble_post_jobs",
  "Full v9 POST /jobs request. Pass the API body verbatim.",
  { body: { type: "object" } },
  ["body"],
);

export const SUMBLE_POST_SIGNALS_DEFINITION = objectTool(
  "sumble_post_signals",
  "Full v9 POST /signals request. Pass the API body verbatim.",
  { body: { type: "object" } },
  ["body"],
);

export const SUMBLE_LIST_CONTACT_LISTS_DEFINITION = objectTool(
  "sumble_list_contact_lists",
  "List saved contact lists via v9 GET /contact-lists.",
  {},
);

export const SUMBLE_GET_CONTACT_LIST_DEFINITION = objectTool(
  "sumble_get_contact_list",
  "Get one contact list via v9 GET /contact-lists/{list_id}.",
  { listId: { type: "number" } },
  ["listId"],
);

export const SUMBLE_CREATE_CONTACT_LIST_DEFINITION = objectTool(
  "sumble_create_contact_list",
  "Create a contact list via v9 POST /contact-lists.",
  { name: { type: "string" } },
  ["name"],
);

export const SUMBLE_ADD_CONTACT_LIST_PEOPLE_DEFINITION = objectTool(
  "sumble_add_contact_list_people",
  "Add people to a contact list via v9 POST /contact-lists/{list_id}/people.",
  {
    listId: { type: "number" },
    personIds: { type: "array", items: { type: "number" } },
  },
  ["listId", "personIds"],
);

export const SUMBLE_LIST_ORGANIZATION_LISTS_DEFINITION = objectTool(
  "sumble_list_organization_lists",
  "List saved organization lists via v9 GET /organization-lists.",
  { includeDeleted: { type: "boolean" } },
);

export const SUMBLE_GET_ORGANIZATION_LIST_DEFINITION = objectTool(
  "sumble_get_organization_list",
  "Get one organization list via v9 GET /organization-lists/{list_id}.",
  { listId: { type: "number" }, includeDeleted: { type: "boolean" } },
  ["listId"],
);

export const SUMBLE_CREATE_ORGANIZATION_LIST_DEFINITION = objectTool(
  "sumble_create_organization_list",
  "Create an organization list via v9 POST /organization-lists.",
  { name: { type: "string" } },
  ["name"],
);

export const SUMBLE_ADD_ORGANIZATION_LIST_ORGANIZATIONS_DEFINITION = objectTool(
  "sumble_add_organization_list_organizations",
  "Add organizations to a list via v9 POST /organization-lists/{list_id}/organizations.",
  {
    listId: { type: "number" },
    organizationIds: { type: "array", items: { type: "number" } },
  },
  ["listId", "organizationIds"],
);

export const SUMBLE_SET_ORGANIZATION_LIST_DELETED_DEFINITION = objectTool(
  "sumble_set_organization_list_deleted",
  "Soft-delete or restore a list via v9 POST /organization-lists/{list_id}/deleted.",
  { listId: { type: "number" }, deleted: { type: "boolean" } },
  ["listId", "deleted"],
);

export const SUMBLE_SET_ORGANIZATION_LIST_SIGNALS_DEFINITION = objectTool(
  "sumble_set_organization_list_signals",
  "Toggle Signals inclusion for a list via v9 POST /organization-lists/{list_id}/signals.",
  { listId: { type: "number" }, includeInSignals: { type: "boolean" } },
  ["listId", "includeInSignals"],
);

export const SUMBLE_CREATE_SUPPORT_REQUEST_DEFINITION = objectTool(
  "sumble_create_support_request",
  "Open a Sumble support ticket via v9 POST /support.",
  {
    subject: { type: "string" },
    message: { type: "string" },
    category: { type: "string" },
  },
  ["subject", "message"],
);

export const SUMBLE_CREATE_DATA_QUALITY_REPORT_DEFINITION = objectTool(
  "sumble_create_data_quality_report",
  "Report data quality issues via v9 POST /support/data-quality.",
  {
    organizationId: { type: "number" },
    organizationSlug: { type: "string" },
    url: { type: "string" },
    notes: { type: "string" },
  },
);
