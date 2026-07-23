import { type } from "arktype";
import { sumbleGet, sumbleGetAsync, sumblePost, sumblePostAsync } from "./http";
import {
  PEOPLE_EMAIL_IDENTIFIER_CREDITS,
  PEOPLE_EMAIL_REVEAL_CREDITS_PER_PERSON,
  estimatePeopleEmailRevealCredits,
} from "./credits";
import {
  INTELLIGENCE_BRIEF_CREDITS,
  SumbleIntelligenceBriefResponse,
  SumbleJobsResponse,
  SumbleOrganizationsResponse,
  SumblePeopleResponse,
  SumbleSignalsResponse,
  SumbleTeamsResponse,
  buildOrgRef,
  flattenJobRow,
  flattenOrgRow,
  flattenPersonRow,
  flattenTeamRow,
  assertNoUngatedPeopleSelectSpend,
  isRecord,
  jsonResult,
  parseArgs,
  parseResponse,
  resolveOrganizationId,
} from "./shared";
import type { SumbleToolsConfig } from "./types";

function organizationLookupRef(ref: {
  organizationId?: number;
  organizationSlug?: string;
  domain?: string;
  name?: string;
  slug?: string;
  identifier?: string;
}): {
  organizationId?: number;
  organizationSlug?: string;
  domain?: string;
  name?: string;
  identifier?: string;
} {
  return {
    ...(ref.organizationId !== undefined
      ? { organizationId: ref.organizationId }
      : {}),
    ...(ref.organizationSlug !== undefined
      ? { organizationSlug: ref.organizationSlug }
      : {}),
    ...(ref.slug !== undefined ? { organizationSlug: ref.slug } : {}),
    ...(ref.domain !== undefined ? { domain: ref.domain } : {}),
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.identifier !== undefined ? { identifier: ref.identifier } : {}),
  };
}

const ResolveOrgArgs = type({
  identifier: "string?",
  domain: "string?",
  slug: "string?",
  name: "string?",
});

const SearchOrgsArgs = type({
  query: "string?",
  industry: "string?",
  minEmployees: "number?",
  maxEmployees: "number?",
  limit: "1<=number<=200?",
  offset: "number?",
});

const TechStackArgs = type({
  identifier: "string?",
  domain: "string?",
  slug: "string?",
  name: "string?",
  limit: "1<=number<=200?",
});

function assertOrganizationIdOrSlug(
  parsed: {
    organizationId?: number;
    organizationSlug?: string;
  },
  toolLabel: string,
): void {
  const hasId = parsed.organizationId !== undefined;
  const hasSlug =
    parsed.organizationSlug !== undefined && parsed.organizationSlug.length > 0;
  if (!hasId && !hasSlug) {
    throw new Error(`${toolLabel} requires organizationId or organizationSlug`);
  }
}

const ListTeamsArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  limit: "1<=number<=200?",
  offset: "number?",
});

const SearchPeopleArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  email: "string?",
  linkedinUrl: "string?",
  personId: "number?",
  title: "string?",
  revealEmail: "boolean?",
  confirmEmailRevealSpend: "boolean?",
  limit: "1<=number<=200?",
  offset: "number?",
});

function peopleSelectAttributes(revealEmail: boolean): string[] {
  const attrs = ["name", "job_title", "linkedin_url"];
  if (revealEmail) {
    attrs.push("email");
  }
  return attrs;
}

const ListJobsArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  limit: "1<=number<=200?",
  offset: "number?",
});

const SearchSignalsArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  technologySlugs: "string[]?",
  jobFunctions: "string[]?",
  priorities: "('high'|'medium'|'low')[]?",
  personIds: "number[]?",
  signalIds: "number[]?",
  accountListIds: "number[]?",
  limit: "number?",
});

const IntelligenceBriefArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  confirmSpend: "boolean?",
});

const ListIdArgs = type({ listId: "number" });
const CreateListArgs = type({ name: "string" });
const AddPeopleArgs = type({
  listId: "number",
  personIds: "number[]",
});
const AddOrganizationsArgs = type({
  listId: "number",
  organizationIds: "number[]",
});
const SetDeletedArgs = type({
  listId: "number",
  deleted: "boolean",
});
const SetSignalsArgs = type({
  listId: "number",
  includeInSignals: "boolean",
});
const OrgSignalsArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  technologySlugs: "string[]?",
});

const JsonBodyArgs = type({ body: "Record<string, unknown>" });
const PostPeopleArgs = type({
  body: "Record<string, unknown>",
  "confirmEmailRevealSpend?": "boolean",
});
const StringArrayArgs = type({ terms: "string[]" });
const TitleLookupArgs = type({ titles: "string[]" });
const SupportArgs = type({
  subject: "string",
  message: "string",
  category: "string?",
});
const DataQualityArgs = type({
  organizationId: "number?",
  organizationSlug: "string?",
  url: "string?",
  notes: "string?",
});

const RESOLVE_ATTRIBUTES = [
  "name",
  "slug",
  "url",
  "industry",
  "employee_count",
  "id",
];

export async function resolveOrganization(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(ResolveOrgArgs, args);
  const orgRef = buildOrgRef(parsed);
  if (Object.keys(orgRef).length === 0) {
    throw new Error(
      "sumble_resolve_organization requires one of: identifier, domain, slug, or name",
    );
  }
  const body = {
    organizations: [orgRef],
    select: { attributes: RESOLVE_ATTRIBUTES },
  };
  const parsedResponse = parseResponse(
    SumbleOrganizationsResponse,
    await sumblePost(config, "/organizations", body, signal),
    "organizations",
  );
  const flat = flattenOrgRow((parsedResponse.organizations ?? [])[0]);
  if (flat === null) {
    throw new Error(
      "sumble_resolve_organization: no organization matched the given identifier",
    );
  }
  if (typeof flat.slug !== "string" || flat.slug.length === 0) {
    throw new Error(
      "sumble_resolve_organization: matched organization has no slug; cannot drive downstream lookups",
    );
  }
  return flat;
}

export async function searchOrganizations(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SearchOrgsArgs, args);
  const parts: string[] = [];
  if (parsed.query !== undefined && parsed.query.length > 0) {
    parts.push(parsed.query);
  }
  if (parsed.industry !== undefined && parsed.industry.length > 0) {
    parts.push(`industry EQ '${parsed.industry.replace(/'/g, "\\'")}'`);
  }
  if (parsed.minEmployees !== undefined) {
    parts.push(`employee_count EQ '${parsed.minEmployees}-'`);
  }
  if (parsed.maxEmployees !== undefined) {
    parts.push(`employee_count EQ '-${parsed.maxEmployees}'`);
  }
  const body: Record<string, unknown> = {
    filter: { query: parts.join(" AND ") || "employee_count EQ '1-'" },
    select: {
      attributes: ["name", "industry", "employee_count", "slug", "url"],
    },
  };
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  if (parsed.offset !== undefined) body.offset = parsed.offset;

  const parsedResponse = parseResponse(
    SumbleOrganizationsResponse,
    await sumblePost(config, "/organizations", body, signal),
    "organizations",
  );
  const rows = (parsedResponse.organizations ?? [])
    .map(flattenOrgRow)
    .filter((r): r is Record<string, unknown> => r !== null);
  return jsonResult(rows);
}

export async function getOrgTechStack(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(TechStackArgs, args);
  const orgId = await resolveOrganizationId(
    config,
    organizationLookupRef(parsed),
    signal,
  );
  const body: Record<string, unknown> = {
    filter: { organization_ids: [orgId] },
    select: { attributes: ["name", "technology_list", "jobs_count"] },
  };
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  const parsedResponse = parseResponse(
    SumbleTeamsResponse,
    await sumblePost(config, "/teams", body, signal),
    "teams",
  );
  const rows = (parsedResponse.teams ?? []).map(flattenTeamRow);
  return jsonResult(rows);
}

export async function listTeams(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(ListTeamsArgs, args);
  assertOrganizationIdOrSlug(parsed, "sumble_list_teams");
  const orgId = await resolveOrganizationId(
    config,
    organizationLookupRef(parsed),
    signal,
  );
  const body: Record<string, unknown> = {
    filter: { organization_ids: [orgId] },
    select: { attributes: ["name", "score", "jobs_count"] },
  };
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  if (parsed.offset !== undefined) body.offset = parsed.offset;
  const parsedResponse = parseResponse(
    SumbleTeamsResponse,
    await sumblePost(config, "/teams", body, signal),
    "teams",
  );
  const rows = (parsedResponse.teams ?? []).map(flattenTeamRow);
  return jsonResult(rows);
}

export async function searchPeople(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SearchPeopleArgs, args);
  const hasPersonRef =
    (parsed.email !== undefined && parsed.email.length > 0) ||
    (parsed.linkedinUrl !== undefined && parsed.linkedinUrl.length > 0) ||
    parsed.personId !== undefined;
  const hasOrgRef =
    parsed.organizationId !== undefined ||
    (parsed.organizationSlug !== undefined &&
      parsed.organizationSlug.length > 0);
  if (!hasPersonRef && !hasOrgRef) {
    throw new Error(
      "sumble_search_people requires organizationSlug, organizationId, or email/linkedinUrl/personId",
    );
  }

  const revealEmail = parsed.revealEmail === true;
  const emailLookup = parsed.email !== undefined && parsed.email.length > 0;
  const needsEmailSpendConfirm = revealEmail || emailLookup;
  if (needsEmailSpendConfirm && parsed.confirmEmailRevealSpend !== true) {
    const limit = parsed.limit ?? 1;
    const est = revealEmail
      ? estimatePeopleEmailRevealCredits(limit)
      : PEOPLE_EMAIL_IDENTIFIER_CREDITS;
    const reason = revealEmail
      ? `email reveal costs up to ${est} credits (${PEOPLE_EMAIL_REVEAL_CREDITS_PER_PERSON} per person)`
      : `lookup by email costs up to ${est} credits`;
    throw new Error(
      `sumble_search_people ${reason}; pass confirmEmailRevealSpend: true to proceed.`,
    );
  }

  let body: Record<string, unknown>;

  if (hasPersonRef) {
    const personRef: Record<string, unknown> = {};
    if (parsed.personId !== undefined) personRef.person_id = parsed.personId;
    if (emailLookup) {
      personRef.email = parsed.email;
    }
    if (parsed.linkedinUrl !== undefined && parsed.linkedinUrl.length > 0) {
      personRef.linkedin_url = parsed.linkedinUrl;
    }
    body = {
      people: [personRef],
      select: { attributes: peopleSelectAttributes(revealEmail) },
    };
  } else {
    const orgId = await resolveOrganizationId(
      config,
      organizationLookupRef(parsed),
      signal,
    );
    const filter: Record<string, unknown> = { organization_ids: [orgId] };
    if (parsed.title !== undefined && parsed.title.length > 0) {
      filter.query = {
        query: `job_title EQ '${parsed.title.replace(/'/g, "\\'")}'`,
      };
    }
    body = {
      filter,
      select: { attributes: peopleSelectAttributes(revealEmail) },
    };
  }
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  if (parsed.offset !== undefined) body.offset = parsed.offset;

  const parsedResponse = parseResponse(
    SumblePeopleResponse,
    await sumblePostAsync(config, "/people", body, signal),
    "people",
  );
  const people = (parsedResponse.people ?? []).map(flattenPersonRow);
  return { people, count: people.length };
}

export async function listJobs(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(ListJobsArgs, args);
  assertOrganizationIdOrSlug(parsed, "sumble_list_jobs");
  const orgId = await resolveOrganizationId(
    config,
    organizationLookupRef(parsed),
    signal,
  );
  const body: Record<string, unknown> = {
    filter: { organization_ids: [orgId] },
    select: { attributes: ["title", "description", "technologies"] },
  };
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  if (parsed.offset !== undefined) body.offset = parsed.offset;
  const parsedResponse = parseResponse(
    SumbleJobsResponse,
    await sumblePost(config, "/jobs", body, signal),
    "jobs",
  );
  const rows = (parsedResponse.jobs ?? []).map(flattenJobRow);
  return jsonResult(rows);
}

export async function searchSignals(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const normalized: Record<string, unknown> = { ...args };
  if (
    normalized.technologySlugs === undefined &&
    normalized.technologies !== undefined
  ) {
    normalized.technologySlugs = normalized.technologies;
  }
  const parsed = parseArgs(SearchSignalsArgs, normalized);
  const filter: Record<string, unknown> = {};
  if (
    parsed.organizationSlug !== undefined ||
    parsed.organizationId !== undefined
  ) {
    filter.organization_ids = [
      await resolveOrganizationId(
        config,
        organizationLookupRef(parsed),
        signal,
      ),
    ];
  }
  if (parsed.technologySlugs !== undefined) {
    filter.technology_slugs = parsed.technologySlugs;
  }
  if (parsed.jobFunctions !== undefined) {
    filter.job_functions = parsed.jobFunctions;
  }
  if (parsed.priorities !== undefined) filter.priorities = parsed.priorities;
  if (parsed.personIds !== undefined) filter.person_ids = parsed.personIds;
  if (parsed.signalIds !== undefined) filter.signal_ids = parsed.signalIds;
  if (parsed.accountListIds !== undefined) {
    filter.account_list_ids = parsed.accountListIds;
  }
  const body: Record<string, unknown> = { filter };
  if (parsed.limit !== undefined) body.limit = parsed.limit;
  const parsedResponse = parseResponse(
    SumbleSignalsResponse,
    await sumblePost(config, "/signals", body, signal),
    "signals",
  );
  return jsonResult(parsedResponse.signals ?? []);
}

export async function getIntelligenceBrief(
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
  const orgId = await resolveOrganizationId(
    config,
    organizationLookupRef(parsed),
    signal,
  );
  const path = `/organizations/${orgId}/intelligence-brief`;
  const parsedResponse = parseResponse(
    SumbleIntelligenceBriefResponse,
    await sumbleGetAsync(config, path, signal),
    "intelligence-brief",
  );
  return jsonResult(parsedResponse);
}

export async function getOrganizationSignals(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(OrgSignalsArgs, args);
  const orgId = await resolveOrganizationId(
    config,
    organizationLookupRef(parsed),
    signal,
  );
  const query: Record<string, string[] | undefined> = {};
  if (parsed.technologySlugs !== undefined) {
    query.technology_slugs = parsed.technologySlugs;
  }
  const parsedResponse = parseResponse(
    SumbleSignalsResponse,
    await sumbleGet(config, `/organizations/${orgId}/signals`, signal, query),
    "organization-signals",
  );
  return jsonResult(parsedResponse.signals ?? []);
}

export async function searchPrioritySignals(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(JsonBodyArgs, args);
  return jsonResult(
    await sumblePost(config, "/signals/priority", parsed.body, signal),
  );
}

export async function lookupJobTitles(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(TitleLookupArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      "/jobs/title-lookup",
      { titles: parsed.titles },
      signal,
    ),
  );
}

export async function lookupProjects(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(StringArrayArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      "/projects/lookup",
      { projects: parsed.terms },
      signal,
    ),
  );
}

export async function lookupTechnologies(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(StringArrayArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      "/technologies/lookup",
      { technologies: parsed.terms },
      signal,
    ),
  );
}

export async function findTechnologies(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(StringArrayArgs, args);
  const query = parsed.terms.join(" ").trim();
  if (query.length === 0) {
    throw new Error("sumble_find_technologies requires non-empty terms");
  }
  return jsonResult(
    await sumblePost(config, "/technologies/find", { query }, signal),
  );
}

export async function lookupTechnologyCategories(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(StringArrayArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      "/technologies/categories/lookup",
      { categories: parsed.terms },
      signal,
    ),
  );
}

export async function postOrganizations(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(JsonBodyArgs, args);
  return jsonResult(
    await sumblePost(config, "/organizations", parsed.body, signal),
  );
}

export async function postTeams(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(JsonBodyArgs, args);
  return jsonResult(await sumblePost(config, "/teams", parsed.body, signal));
}

export async function postPeople(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(PostPeopleArgs, args);
  assertNoUngatedPeopleSelectSpend(
    "sumble_post_people",
    parsed.body,
    parsed.confirmEmailRevealSpend,
  );
  return jsonResult(
    await sumblePostAsync(config, "/people", parsed.body, signal),
  );
}

export async function postJobs(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(JsonBodyArgs, args);
  return jsonResult(await sumblePost(config, "/jobs", parsed.body, signal));
}

export async function postSignals(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(JsonBodyArgs, args);
  return jsonResult(await sumblePost(config, "/signals", parsed.body, signal));
}

export async function listContactLists(
  config: SumbleToolsConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  return jsonResult(await sumbleGet(config, "/contact-lists", signal));
}

export async function getContactList(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(ListIdArgs, args);
  return jsonResult(
    await sumbleGet(config, `/contact-lists/${parsed.listId}`, signal),
  );
}

export async function createContactList(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(CreateListArgs, args);
  return jsonResult(
    await sumblePost(config, "/contact-lists", { name: parsed.name }, signal),
  );
}

export async function addContactListPeople(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(AddPeopleArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      `/contact-lists/${parsed.listId}/people`,
      { person_ids: parsed.personIds },
      signal,
    ),
  );
}

export async function listOrganizationLists(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const includeDeleted =
    args.includeDeleted === true ? { include_deleted: "true" } : undefined;
  return jsonResult(
    await sumbleGet(config, "/organization-lists", signal, includeDeleted),
  );
}

export type SumbleOrganizationListOption = { value: string; label: string };

const OrganizationListRowSchema = type({
  "id?": "number | string",
  "list_id?": "number | string",
  "name?": "string",
  "title?": "string",
  "+": "ignore",
});

function extractOrganizationListRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const key of ["organization_lists", "lists", "data", "items"]) {
      const value = raw[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw new Error(
    "sumble_list_organization_lists: unexpected response shape from Sumble (expected an array of lists)",
  );
}

/**
 * Maps a `sumble_list_organization_lists` response into schedule-field-select
 * options (CL-4279): human-readable name as label, list id as value. A row
 * with no usable id is dropped rather than shown as an unselectable option;
 * a response that is not list-shaped at all fails loudly instead of
 * degrading to an empty list.
 */
export function mapOrganizationListsToOptions(
  raw: unknown,
): SumbleOrganizationListOption[] {
  const rows = extractOrganizationListRows(raw);
  const options: SumbleOrganizationListOption[] = [];
  for (const row of rows) {
    const parsed = OrganizationListRowSchema(row);
    if (parsed instanceof type.errors) continue;
    const id = parsed.id ?? parsed.list_id;
    if (id === undefined) continue;
    const value = String(id);
    const label = parsed.name ?? parsed.title ?? `List ${value}`;
    options.push({ value, label });
  }
  return options;
}

export async function getOrganizationList(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(ListIdArgs, args);
  const query =
    args.includeDeleted === true ? { include_deleted: "true" } : undefined;
  const response = await sumbleGet(
    config,
    `/organization-lists/${parsed.listId}`,
    signal,
    query,
  );
  if (!isRecord(response)) {
    throw new Error(
      "sumble_get_organization_list: unexpected non-object response from Sumble",
    );
  }
  return response;
}

export async function createOrganizationList(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(CreateListArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      "/organization-lists",
      { name: parsed.name },
      signal,
    ),
  );
}

export async function setOrganizationListDeleted(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SetDeletedArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      `/organization-lists/${parsed.listId}/deleted`,
      { deleted: parsed.deleted },
      signal,
    ),
  );
}

export async function addOrganizationListOrganizations(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(AddOrganizationsArgs, args);
  const response = await sumblePost(
    config,
    `/organization-lists/${parsed.listId}/organizations`,
    { organization_ids: parsed.organizationIds },
    signal,
  );
  if (!isRecord(response)) {
    throw new Error(
      "sumble_add_organization_list_organizations: unexpected non-object response from Sumble",
    );
  }
  return response;
}

export async function setOrganizationListSignals(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SetSignalsArgs, args);
  return jsonResult(
    await sumblePost(
      config,
      `/organization-lists/${parsed.listId}/signals`,
      { include_in_signals: parsed.includeInSignals },
      signal,
    ),
  );
}

export async function createSupportRequest(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(SupportArgs, args);
  const body: Record<string, unknown> = {
    subject: parsed.subject,
    message: parsed.message,
  };
  if (parsed.category !== undefined) body.category = parsed.category;
  return jsonResult(await sumblePost(config, "/support", body, signal));
}

export async function createDataQualityReport(
  config: SumbleToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = parseArgs(DataQualityArgs, args);
  const body: Record<string, unknown> = {};
  if (parsed.notes !== undefined) body.notes = parsed.notes;
  if (parsed.url !== undefined) body.url = parsed.url;
  if (parsed.organizationId !== undefined) {
    body.organization_id = parsed.organizationId;
  } else if (parsed.organizationSlug !== undefined) {
    body.organization_id = await resolveOrganizationId(
      config,
      { organizationSlug: parsed.organizationSlug },
      signal,
    );
  }
  return jsonResult(
    await sumblePost(config, "/support/data-quality", body, signal),
  );
}
