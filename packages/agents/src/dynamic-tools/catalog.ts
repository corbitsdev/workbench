import type { ToolCatalog, ToolCatalogEntry } from "@workbench/tools-catalog";
import { canonicalizeToolNames, toLlmToolName } from "../tool-names";

/**
 * Build a catalog entry from bare tool names (e.g. `attio_query_records`),
 * converting each to the LLM-facing name the sidecar advertises
 * (`canonicalizeToolNames` → `toLlmToolName`, e.g. `attio__query_records`) so
 * the director and `load_tools` match live definitions without transformation.
 */
function entry(
  pkg: string,
  summary: string,
  tags: string[],
  tools: { bare: string; description: string }[],
): ToolCatalogEntry {
  return {
    package: pkg,
    summary,
    tags,
    tools: tools.map((t) => ({
      name: toLlmToolName(canonicalizeToolNames([t.bare])[0] ?? t.bare),
      description: t.description,
    })),
  };
}

/**
 * The long-tail tool packages Myra loads on demand. Everything Myra has
 * loaded stays dispatchable; these packages are simply not advertised to the
 * model until `load_tools` enables them. Base packages Myra uses in most
 * chats (skills, artifact/memory, exa/web search, workflows, agents/identity)
 * are always advertised and are NOT listed here.
 */
export const MYRA_TOOL_CATALOG: ToolCatalog = [
  entry(
    "attio",
    "Attio CRM — companies, people, deals, tasks, and notes.",
    ["crm", "attio", "companies", "people", "deals", "contacts", "tasks"],
    [
      { bare: "attio_list_objects", description: "List the CRM object types." },
      {
        bare: "attio_query_records",
        description: "Query records of an object.",
      },
      { bare: "attio_search_records", description: "Search records by text." },
      { bare: "attio_get_record", description: "Fetch one record by id." },
      {
        bare: "attio_list_workspace_members",
        description: "List workspace members.",
      },
      { bare: "attio_list_tasks", description: "List CRM tasks." },
      { bare: "attio_get_task", description: "Fetch one task by id." },
      { bare: "attio_update_task", description: "Update a task." },
      { bare: "attio_create_note", description: "Create a note on a record." },
    ],
  ),
  entry(
    "linear",
    "Linear — issues, teams, and users for product/engineering work.",
    ["linear", "issues", "tickets", "engineering", "product", "tasks"],
    [
      { bare: "linear_list_issues", description: "List/filter Linear issues." },
      { bare: "linear_get_issue", description: "Fetch one issue by id." },
      { bare: "linear_list_teams", description: "List Linear teams." },
      { bare: "linear_list_users", description: "List Linear users." },
    ],
  ),
  entry(
    "granola",
    "Granola — meeting notes, transcripts, and folders.",
    ["granola", "meetings", "notes", "transcripts", "calls"],
    [
      { bare: "granola_list_notes", description: "List meeting notes." },
      { bare: "granola_get_note", description: "Fetch one note/transcript." },
      { bare: "granola_list_folders", description: "List note folders." },
    ],
  ),
  entry(
    "vercel",
    "Vercel — projects, deployments, and static file deploys.",
    ["vercel", "deploy", "deployment", "hosting", "projects"],
    [
      { bare: "vercel_list_projects", description: "List Vercel projects." },
      {
        bare: "vercel_list_deployments",
        description: "List deployments for a project.",
      },
      {
        bare: "vercel_deploy_static_file",
        description: "Deploy a static file to Vercel.",
      },
    ],
  ),
  entry(
    "fileparser",
    "Document parsing — read PDFs, documents, and images as text.",
    ["file", "parse", "pdf", "document", "ocr", "attachment"],
    [
      {
        bare: "parse_file",
        description: "Parse a PDF/document/image and return its text.",
      },
    ],
  ),
];
