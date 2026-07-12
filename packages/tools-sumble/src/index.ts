import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type SumbleFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const SumbleToolsConfig = type({
  apiKey: "string",
  "baseUrl?": "string",
  "fetcher?": "unknown",
});

export type SumbleToolsConfig = typeof SumbleToolsConfig.infer & {
  fetcher?: SumbleFetch;
};

const DEFAULT_BASE_URL = "https://api.sumble.com/v8";
const DEFAULT_RETRY_AFTER_SECONDS = 2;
const MAX_POLL_ATTEMPTS = 10;
const INTELLIGENCE_BRIEF_CREDITS = 50;

// ---------------------------------------------------------------------------
// Response schemas — parsed at the API boundary (never `as`). Sumble responses
// are loose; each schema pins the field the handler extracts and tolerates the
// extra/optional fields Sumble returns.
// ---------------------------------------------------------------------------

export const SumbleOrganizationsResponse = type({
  "organizations?": "unknown[]",
});
export type SumbleOrganizationsResponse =
  typeof SumbleOrganizationsResponse.infer;

export const SumbleTeamsResponse = type({
  "teams?": "unknown[]",
});
export type SumbleTeamsResponse = typeof SumbleTeamsResponse.infer;

export const SumblePeopleResponse = type({
  "people?": "unknown[]",
});
export type SumblePeopleResponse = typeof SumblePeopleResponse.infer;

export const SumbleJobsResponse = type({
  "jobs?": "unknown[]",
});
export type SumbleJobsResponse = typeof SumbleJobsResponse.infer;

export const SumbleSignalsResponse = type({
  "signals?": "unknown[]",
});
export type SumbleSignalsResponse = typeof SumbleSignalsResponse.infer;

export const SumbleIntelligenceBriefResponse = type({
  "organization_slug?": "string",
  "brief?": "unknown",
});
export type SumbleIntelligenceBriefResponse =
  typeof SumbleIntelligenceBriefResponse.infer;

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const ResolveOrgArgs = type({
  "domain?": "string",
  "slug?": "string",
  "name?": "string",
});

const SearchOrgsArgs = type({
  "query?": "string",
  "industry?": "string",
  "minEmployees?": "number",
  "maxEmployees?": "number",
  "limit?": "number",
});

const TechStackArgs = type({
  "slug?": "string",
  "domain?": "string",
  "name?": "string",
});

const ListTeamsArgs = type({
  organizationSlug: "string > 0",
  "limit?": "number",
});

const SearchPeopleArgs = type({
  "organizationSlug?": "string",
  "email?": "string",
  "title?": "string",
  "limit?": "number",
});

const ListJobsArgs = type({
  organizationSlug: "string > 0",
  "limit?": "number",
});

const SearchSignalsArgs = type({
  "organizationSlug?": "string",
  "technologies?": "string[]",
  "limit?": "number",
});

const IntelligenceBriefArgs = type({
  organizationSlug: "string > 0",
  "confirmSpend?": "boolean",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sumbleHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function validateConfig(config: SumbleToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Sumble apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Sumble baseUrl must be a valid URL");
    }
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

function parseRetryAfter(header: string | null): number {
  if (header === null) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return seconds;
}

// Sleep that resolves after `ms`, or rejects immediately if the signal aborts.
function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Sumble request aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Sumble request aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort);
  });
}

// POST to a Sumble endpoint. On 202 Accepted (async in progress) it re-POSTs the
// same request after Retry-After, bounded by MAX_POLL_ATTEMPTS. Fails loudly on
// timeout — never returns partial/empty.
async function sumbleRequest(
  config: SumbleToolsConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const url = `${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}${path}`;
  const fetcher = config.fetcher ?? fetch;
  let attempts = 0;

  for (;;) {
    const response = await fetcher(url, {
      method: "POST",
      headers: sumbleHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal,
    } satisfies RequestInit);

    if (response.status === 202) {
      attempts += 1;
      if (attempts >= MAX_POLL_ATTEMPTS) {
        throw new Error(
          `Sumble ${path} did not complete after ${MAX_POLL_ATTEMPTS} polling attempts`,
        );
      }
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      await waitAbortable(retryAfter * 1000, signal);
      continue;
    }

    if (!response.ok) {
      const bodyText = errorMessageFromBody(
        await response.text().catch(() => ""),
      );
      const detail = response.statusText || bodyText;
      throw new Error(`Sumble API error: ${response.status} ${detail ?? ""}`);
    }

    return await response.json();
  }
}

function parseArgs<T>(
  schema: (value: unknown) => T | type.errors,
  args: Record<string, unknown>,
): T {
  const parsed = schema(args);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  return parsed;
}

function parseResponse<T>(
  schema: (value: unknown) => T | type.errors,
  value: unknown,
  label: string,
): T {
  const parsed = schema(value);
  if (parsed instanceof type.errors) {
    throw new Error(`Sumble ${label} response is invalid: ${parsed.summary}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const RESOLVE_ATTRIBUTES = [
  "name",
  "slug",
  "url",
  "industry",
  "employee_count",
];

async function resolveOrganization(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(ResolveOrgArgs, args);
  const orgRef: Record<string, string> = {};
  if (parsed.domain !== undefined && parsed.domain.length > 0) {
    orgRef.url = parsed.domain;
  } else if (parsed.slug !== undefined && parsed.slug.length > 0) {
    orgRef.slug = parsed.slug;
  } else if (parsed.name !== undefined && parsed.name.length > 0) {
    orgRef.name = parsed.name;
  }
  if (Object.keys(orgRef).length === 0) {
    throw new Error(
      "sumble_resolve_organization requires one of: domain, slug, or name",
    );
  }

  const body = {
    organizations: [orgRef],
    select: { attributes: RESOLVE_ATTRIBUTES },
  };
  const parsedResponse = parseResponse(
    SumbleOrganizationsResponse,
    await sumbleRequest(config, "/organizations", body, signal),
    "organizations",
  );
  const organizations = parsedResponse.organizations ?? [];
  return jsonResult(organizations[0] ?? null);
}

async function searchOrganizations(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SearchOrgsArgs, args);
  const filter: Record<string, unknown> = {};
  if (parsed.query !== undefined && parsed.query.length > 0) {
    filter.query = parsed.query;
  }
  if (parsed.industry !== undefined && parsed.industry.length > 0) {
    filter.industry = parsed.industry;
  }
  if (parsed.minEmployees !== undefined) {
    filter.min_employees = parsed.minEmployees;
  }
  if (parsed.maxEmployees !== undefined) {
    filter.max_employees = parsed.maxEmployees;
  }

  const body: Record<string, unknown> = {
    filter,
    select: { attributes: ["name", "industry", "employee_count"] },
  };
  if (parsed.limit !== undefined) {
    body.limit = parsed.limit;
  }

  const parsedResponse = parseResponse(
    SumbleOrganizationsResponse,
    await sumbleRequest(config, "/organizations", body, signal),
    "organizations",
  );
  return jsonResult(parsedResponse.organizations ?? []);
}

async function getOrgTechStack(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(TechStackArgs, args);
  const orgRef: Record<string, string> = {};
  if (parsed.slug !== undefined && parsed.slug.length > 0) {
    orgRef.slug = parsed.slug;
  } else if (parsed.domain !== undefined && parsed.domain.length > 0) {
    orgRef.url = parsed.domain;
  } else if (parsed.name !== undefined && parsed.name.length > 0) {
    orgRef.name = parsed.name;
  }
  if (Object.keys(orgRef).length === 0) {
    throw new Error(
      "sumble_get_org_tech_stack requires one of: slug, domain, or name",
    );
  }

  const body = {
    organizations: [orgRef],
    select: {
      entities: [{ type: "technology", metrics: ["job_post_count"] }],
    },
  };
  const parsedResponse = parseResponse(
    SumbleOrganizationsResponse,
    await sumbleRequest(config, "/organizations", body, signal),
    "organizations",
  );
  return jsonResult(parsedResponse.organizations ?? []);
}

async function listTeams(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(ListTeamsArgs, args);
  const body: Record<string, unknown> = {
    teams: [{ organization_slug: parsed.organizationSlug }],
    select: {
      attributes: ["name", "icp_fit_score"],
      entities: [{ type: "job_post" }],
    },
  };
  if (parsed.limit !== undefined) {
    body.limit = parsed.limit;
  }
  const parsedResponse = parseResponse(
    SumbleTeamsResponse,
    await sumbleRequest(config, "/teams", body, signal),
    "teams",
  );
  return jsonResult(parsedResponse.teams ?? []);
}

async function searchPeople(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SearchPeopleArgs, args);
  const personRef: Record<string, string> = {};
  if (
    parsed.organizationSlug !== undefined &&
    parsed.organizationSlug.length > 0
  ) {
    personRef.organization_slug = parsed.organizationSlug;
  }
  if (parsed.email !== undefined && parsed.email.length > 0) {
    personRef.email = parsed.email;
  }
  if (Object.keys(personRef).length === 0) {
    throw new Error("sumble_search_people requires organizationSlug or email");
  }
  if (parsed.title !== undefined && parsed.title.length > 0) {
    personRef.title = parsed.title;
  }

  const body: Record<string, unknown> = {
    people: [personRef],
    select: { attributes: ["name", "title", "email"] },
  };
  if (parsed.limit !== undefined) {
    body.limit = parsed.limit;
  }
  const parsedResponse = parseResponse(
    SumblePeopleResponse,
    await sumbleRequest(config, "/people", body, signal),
    "people",
  );
  return jsonResult(parsedResponse.people ?? []);
}

async function listJobs(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(ListJobsArgs, args);
  const body: Record<string, unknown> = {
    jobs: [{ organization_slug: parsed.organizationSlug }],
    select: { attributes: ["title", "description", "technologies"] },
  };
  if (parsed.limit !== undefined) {
    body.limit = parsed.limit;
  }
  const parsedResponse = parseResponse(
    SumbleJobsResponse,
    await sumbleRequest(config, "/jobs", body, signal),
    "jobs",
  );
  return jsonResult(parsedResponse.jobs ?? []);
}

async function searchSignals(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SearchSignalsArgs, args);
  const filter: Record<string, unknown> = {};
  if (
    parsed.organizationSlug !== undefined &&
    parsed.organizationSlug.length > 0
  ) {
    filter.organization_slug = parsed.organizationSlug;
  }
  if (parsed.technologies !== undefined && parsed.technologies.length > 0) {
    filter.technologies = parsed.technologies;
  }

  const body: Record<string, unknown> = { filter };
  if (parsed.limit !== undefined) {
    body.limit = parsed.limit;
  }
  const parsedResponse = parseResponse(
    SumbleSignalsResponse,
    await sumbleRequest(config, "/signals", body, signal),
    "signals",
  );
  return jsonResult(parsedResponse.signals ?? []);
}

async function getIntelligenceBrief(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(IntelligenceBriefArgs, args);
  if (parsed.confirmSpend !== true) {
    throw new Error(
      `sumble_get_intelligence_brief costs ${INTELLIGENCE_BRIEF_CREDITS} credits per call; pass confirmSpend: true to proceed.`,
    );
  }
  const body = { organization_slug: parsed.organizationSlug };
  const parsedResponse = parseResponse(
    SumbleIntelligenceBriefResponse,
    await sumbleRequest(config, "/intelligence-briefs", body, signal),
    "intelligence-briefs",
  );
  return jsonResult(parsedResponse);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const SUMBLE_RESOLVE_ORGANIZATION_DEFINITION: ToolDefinition = {
  name: "sumble_resolve_organization",
  description:
    "Resolve a company to its Sumble organization by domain, slug, or name. Returns the matched org's core attributes (name, slug, url, industry, employee_count) as a JSON object, or null when unmatched. Provide at least one of domain, slug, or name.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Company domain or URL." },
      slug: { type: "string", description: "Sumble organization slug." },
      name: { type: "string", description: "Company name." },
    },
    required: [],
  },
};

export const SUMBLE_SEARCH_ORGANIZATIONS_DEFINITION: ToolDefinition = {
  name: "sumble_search_organizations",
  description:
    "Search Sumble organizations by keyword query, industry, and employee-count range. Returns a JSON array of matched organizations with name, industry, and employee_count.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search query." },
      industry: { type: "string", description: "Industry filter." },
      minEmployees: {
        type: "number",
        description: "Minimum employee count.",
      },
      maxEmployees: {
        type: "number",
        description: "Maximum employee count.",
      },
      limit: { type: "number", description: "Maximum results to return." },
    },
    required: [],
  },
};

export const SUMBLE_GET_ORG_TECH_STACK_DEFINITION: ToolDefinition = {
  name: "sumble_get_org_tech_stack",
  description:
    "Get an organization's technology stack from Sumble, including per-technology job-post counts. Provide one of slug, domain, or name. Returns a JSON array of organizations with their technology entities.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Sumble organization slug." },
      domain: { type: "string", description: "Company domain or URL." },
      name: { type: "string", description: "Company name." },
    },
    required: [],
  },
};

export const SUMBLE_LIST_TEAMS_DEFINITION: ToolDefinition = {
  name: "sumble_list_teams",
  description:
    "List the teams within an organization, with name, ICP-fit score, and associated job posts. Returns a JSON array of teams.",
  inputSchema: {
    type: "object",
    properties: {
      organizationSlug: {
        type: "string",
        description: "Sumble organization slug.",
      },
      limit: { type: "number", description: "Maximum teams to return." },
    },
    required: ["organizationSlug"],
  },
};

export const SUMBLE_SEARCH_PEOPLE_DEFINITION: ToolDefinition = {
  name: "sumble_search_people",
  description:
    "Search people at an organization (by slug) or resolve a single person by email. Returns a JSON array of people with name, title, and email. This call may run asynchronously and is polled to completion.",
  inputSchema: {
    type: "object",
    properties: {
      organizationSlug: {
        type: "string",
        description: "Sumble organization slug.",
      },
      email: { type: "string", description: "Person email to resolve." },
      title: { type: "string", description: "Job-title filter." },
      limit: { type: "number", description: "Maximum people to return." },
    },
    required: [],
  },
};

export const SUMBLE_LIST_JOBS_DEFINITION: ToolDefinition = {
  name: "sumble_list_jobs",
  description:
    "List open job posts for an organization, with title, description, and detected technologies. Returns a JSON array of jobs.",
  inputSchema: {
    type: "object",
    properties: {
      organizationSlug: {
        type: "string",
        description: "Sumble organization slug.",
      },
      limit: { type: "number", description: "Maximum jobs to return." },
    },
    required: ["organizationSlug"],
  },
};

export const SUMBLE_SEARCH_SIGNALS_DEFINITION: ToolDefinition = {
  name: "sumble_search_signals",
  description:
    "Search Sumble buying/intent signals, filtered by organization slug and/or technologies. Returns a JSON array of signals.",
  inputSchema: {
    type: "object",
    properties: {
      organizationSlug: {
        type: "string",
        description: "Sumble organization slug.",
      },
      technologies: {
        type: "array",
        items: { type: "string" },
        description: "Technologies to filter signals by.",
      },
      limit: { type: "number", description: "Maximum signals to return." },
    },
    required: [],
  },
};

export const SUMBLE_GET_INTELLIGENCE_BRIEF_DEFINITION: ToolDefinition = {
  name: "sumble_get_intelligence_brief",
  description:
    "Generate a full Sumble intelligence brief for an organization. COST: 50 credits per completed brief — this is a paid, gated call. You MUST pass confirmSpend: true to proceed; without it the tool refuses and spends nothing. This call may run asynchronously and is polled to completion. Returns the brief as a JSON object.",
  inputSchema: {
    type: "object",
    properties: {
      organizationSlug: {
        type: "string",
        description: "Sumble organization slug.",
      },
      confirmSpend: {
        type: "boolean",
        description:
          "Must be true to authorize the 50-credit spend. Omitted or false refuses the call.",
      },
    },
    required: ["organizationSlug", "confirmSpend"],
  },
};

type SumbleToolRun = (
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string>;

const TOOL_SPECS: { definition: ToolDefinition; run: SumbleToolRun }[] = [
  {
    definition: SUMBLE_RESOLVE_ORGANIZATION_DEFINITION,
    run: resolveOrganization,
  },
  {
    definition: SUMBLE_SEARCH_ORGANIZATIONS_DEFINITION,
    run: searchOrganizations,
  },
  { definition: SUMBLE_GET_ORG_TECH_STACK_DEFINITION, run: getOrgTechStack },
  { definition: SUMBLE_LIST_TEAMS_DEFINITION, run: listTeams },
  { definition: SUMBLE_SEARCH_PEOPLE_DEFINITION, run: searchPeople },
  { definition: SUMBLE_LIST_JOBS_DEFINITION, run: listJobs },
  { definition: SUMBLE_SEARCH_SIGNALS_DEFINITION, run: searchSignals },
  {
    definition: SUMBLE_GET_INTELLIGENCE_BRIEF_DEFINITION,
    run: getIntelligenceBrief,
  },
];

function toAgentTool(
  config: SumbleToolsConfig,
  spec: { definition: ToolDefinition; run: SumbleToolRun },
): AgentTool {
  return {
    kind: "string",
    definition: spec.definition,
    handler: (args, signal) => spec.run(config, args, signal),
  };
}

export function createSumbleTools(config: SumbleToolsConfig): AgentTool[] {
  validateConfig(config);
  return TOOL_SPECS.map((spec) => toAgentTool(config, spec));
}

function createSumbleToolFor(
  config: SumbleToolsConfig,
  definition: ToolDefinition,
): AgentTool[] {
  validateConfig(config);
  const spec = TOOL_SPECS.find(
    (candidate) => candidate.definition.name === definition.name,
  );
  if (spec === undefined) {
    throw new Error(`Unknown Sumble tool: ${definition.name}`);
  }
  return [toAgentTool(config, spec)];
}

/**
 * Hub tool registry entries for sumble. Each entry declares the tool
 * definition, the Interchange provider name for credential resolution, and a
 * factory that returns the AgentTool handlers given resolved credentials.
 *
 * Import and spread into the hub's KNOWN_TOOLS to register.
 */
export const SUMBLE_HUB_TOOLS = {
  sumble_resolve_organization: {
    sideEffect: "read" as const,
    definition: SUMBLE_RESOLVE_ORGANIZATION_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_RESOLVE_ORGANIZATION_DEFINITION,
      ),
  },
  sumble_search_organizations: {
    sideEffect: "read" as const,
    definition: SUMBLE_SEARCH_ORGANIZATIONS_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_SEARCH_ORGANIZATIONS_DEFINITION,
      ),
  },
  sumble_get_org_tech_stack: {
    sideEffect: "read" as const,
    definition: SUMBLE_GET_ORG_TECH_STACK_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_GET_ORG_TECH_STACK_DEFINITION,
      ),
  },
  sumble_list_teams: {
    sideEffect: "read" as const,
    definition: SUMBLE_LIST_TEAMS_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_LIST_TEAMS_DEFINITION,
      ),
  },
  sumble_search_people: {
    sideEffect: "read" as const,
    definition: SUMBLE_SEARCH_PEOPLE_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_SEARCH_PEOPLE_DEFINITION,
      ),
  },
  sumble_list_jobs: {
    sideEffect: "read" as const,
    definition: SUMBLE_LIST_JOBS_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_LIST_JOBS_DEFINITION,
      ),
  },
  sumble_search_signals: {
    sideEffect: "read" as const,
    definition: SUMBLE_SEARCH_SIGNALS_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_SEARCH_SIGNALS_DEFINITION,
      ),
  },
  sumble_get_intelligence_brief: {
    sideEffect: "read" as const,
    definition: SUMBLE_GET_INTELLIGENCE_BRIEF_DEFINITION,
    providerName: "sumble" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSumbleToolFor(
        { apiKey: config.apiKey },
        SUMBLE_GET_INTELLIGENCE_BRIEF_DEFINITION,
      ),
  },
};
