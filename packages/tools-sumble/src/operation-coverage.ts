export type SumbleHttpOperation = {
  method: "GET" | "POST";
  path: string;
  tools: string[];
};

export const SUMBLE_V9_OPERATION_COVERAGE: SumbleHttpOperation[] = [
  {
    method: "POST",
    path: "/v9/organizations",
    tools: [
      "sumble_resolve_organization",
      "sumble_search_organizations",
      "sumble_post_organizations",
    ],
  },
  {
    method: "POST",
    path: "/v9/teams",
    tools: [
      "sumble_list_teams",
      "sumble_get_org_tech_stack",
      "sumble_post_teams",
    ],
  },
  {
    method: "POST",
    path: "/v9/people",
    tools: ["sumble_search_people", "sumble_post_people"],
  },
  {
    method: "POST",
    path: "/v9/jobs",
    tools: ["sumble_list_jobs", "sumble_post_jobs"],
  },
  {
    method: "POST",
    path: "/v9/signals",
    tools: ["sumble_search_signals", "sumble_post_signals"],
  },
  {
    method: "GET",
    path: "/v9/organizations/{organization_id}/intelligence-brief",
    tools: ["sumble_get_intelligence_brief"],
  },
  {
    method: "GET",
    path: "/v9/organizations/{organization_id}/signals",
    tools: ["sumble_get_organization_signals"],
  },
  {
    method: "POST",
    path: "/v9/signals/priority",
    tools: ["sumble_search_priority_signals"],
  },
  {
    method: "POST",
    path: "/v9/jobs/title-lookup",
    tools: ["sumble_lookup_job_titles"],
  },
  {
    method: "POST",
    path: "/v9/projects/lookup",
    tools: ["sumble_lookup_projects"],
  },
  {
    method: "POST",
    path: "/v9/technologies/lookup",
    tools: ["sumble_lookup_technologies"],
  },
  {
    method: "POST",
    path: "/v9/technologies/find",
    tools: ["sumble_find_technologies"],
  },
  {
    method: "POST",
    path: "/v9/technologies/categories/lookup",
    tools: ["sumble_lookup_technology_categories"],
  },
  {
    method: "GET",
    path: "/v9/contact-lists",
    tools: ["sumble_list_contact_lists"],
  },
  {
    method: "GET",
    path: "/v9/contact-lists/{list_id}",
    tools: ["sumble_get_contact_list"],
  },
  {
    method: "POST",
    path: "/v9/contact-lists",
    tools: ["sumble_create_contact_list"],
  },
  {
    method: "POST",
    path: "/v9/contact-lists/{list_id}/people",
    tools: ["sumble_add_contact_list_people"],
  },
  {
    method: "GET",
    path: "/v9/organization-lists",
    tools: ["sumble_list_organization_lists"],
  },
  {
    method: "GET",
    path: "/v9/organization-lists/{list_id}",
    tools: ["sumble_get_organization_list"],
  },
  {
    method: "POST",
    path: "/v9/organization-lists",
    tools: ["sumble_create_organization_list"],
  },
  {
    method: "POST",
    path: "/v9/organization-lists/{list_id}/deleted",
    tools: ["sumble_set_organization_list_deleted"],
  },
  {
    method: "POST",
    path: "/v9/organization-lists/{list_id}/organizations",
    tools: ["sumble_add_organization_list_organizations"],
  },
  {
    method: "POST",
    path: "/v9/organization-lists/{list_id}/signals",
    tools: ["sumble_set_organization_list_signals"],
  },
  {
    method: "POST",
    path: "/v9/support",
    tools: ["sumble_create_support_request"],
  },
  {
    method: "POST",
    path: "/v9/support/data-quality",
    tools: ["sumble_create_data_quality_report"],
  },
];

export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
