import { type } from "arktype";
import type { SumbleToolsConfig } from "./types";
import { sumblePost } from "./http";

export const INTELLIGENCE_BRIEF_CREDITS = 50;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

export function parseArgs<T>(
  schema: (value: unknown) => T | type.errors,
  args: Record<string, unknown>,
): T {
  const parsed = schema(args);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  return parsed;
}

export function parseResponse<T>(
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

const LooseObject = type("Record<string, unknown>");
const LooseArray = type("unknown[]");

export const SumbleOrganizationsResponse = type({
  organizations: LooseArray.optional(),
});

export const SumbleTeamsResponse = type({
  teams: LooseArray.optional(),
});

export const SumblePeopleResponse = type({
  people: LooseArray.optional(),
});

export const SumbleJobsResponse = type({
  jobs: LooseArray.optional(),
});

export const SumbleSignalsResponse = type({
  signals: LooseArray.optional(),
});

export const SumbleIntelligenceBriefResponse = LooseObject;

export function flattenOrgRow(row: unknown): Record<string, unknown> | null {
  if (!isRecord(row)) return null;
  if (isRecord(row.attributes)) {
    return {
      ...row.attributes,
      entities: row.entities,
      input: row.input,
    };
  }
  return row;
}

export function flattenPersonRow(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {};
  if (isRecord(row.attributes)) {
    return {
      person_id: row.person_id ?? row.attributes.person_id,
      ...row.attributes,
      related_people: row.related_people,
      input: row.input,
    };
  }
  return row;
}

export function flattenTeamRow(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {};
  if (isRecord(row.attributes)) {
    return {
      team_id: row.team_id,
      name: row.name,
      sumble_url: row.sumble_url,
      ...row.attributes,
      related_people: row.related_people,
      job_posts: row.job_posts,
      input: row.input,
    };
  }
  return row;
}

export function flattenJobRow(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {};
  if (isRecord(row.attributes)) {
    return {
      job_id: row.job_id,
      sumble_url: row.sumble_url,
      ...row.attributes,
      related_people: row.related_people,
      input: row.input,
    };
  }
  return row;
}

export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.includes(" ")) return false;
  const hostish = trimmed.replace(/^www\./i, "");
  const parts = hostish.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1] ?? "";
  return /^[a-z]{2,24}$/i.test(tld);
}

export function normalizeUrlHost(value: string): string {
  const trimmed = value.trim();
  try {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return trimmed.replace(/^www\./i, "").toLowerCase();
  }
}

export function classifyIdentifier(identifier: string): {
  domain?: string;
  slug?: string;
  name?: string;
} {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return {};
  if (looksLikeUrl(trimmed)) {
    return { domain: normalizeUrlHost(trimmed) };
  }
  if (trimmed.includes(" ")) {
    return { name: trimmed };
  }
  return { slug: trimmed };
}

export function buildOrgRef(parsed: {
  identifier?: string;
  domain?: string;
  slug?: string;
  name?: string;
}): Record<string, string> {
  if (parsed.identifier !== undefined && parsed.identifier.length > 0) {
    const classified = classifyIdentifier(parsed.identifier);
    if (classified.domain !== undefined) {
      return { url: classified.domain };
    }
    if (classified.name !== undefined) {
      return { name: classified.name };
    }
    if (classified.slug !== undefined) {
      return { slug: classified.slug };
    }
  }
  const ref: Record<string, string> = {};
  if (parsed.domain !== undefined && parsed.domain.length > 0) {
    ref.url = normalizeUrlHost(parsed.domain);
  }
  if (parsed.slug !== undefined && parsed.slug.length > 0) {
    ref.slug = parsed.slug;
  }
  if (parsed.name !== undefined && parsed.name.length > 0) {
    ref.name = parsed.name;
  }
  return ref;
}

export async function resolveOrganizationId(
  config: SumbleToolsConfig,
  ref: {
    organizationId?: number;
    organizationSlug?: string;
    domain?: string;
    name?: string;
    identifier?: string;
  },
  signal: AbortSignal,
): Promise<number> {
  if (ref.organizationId !== undefined) {
    return ref.organizationId;
  }
  const orgRef = buildOrgRef({
    ...(ref.identifier !== undefined ? { identifier: ref.identifier } : {}),
    ...(ref.organizationSlug !== undefined
      ? { slug: ref.organizationSlug }
      : {}),
    ...(ref.domain !== undefined ? { domain: ref.domain } : {}),
    ...(ref.name !== undefined ? { name: ref.name } : {}),
  });
  if (Object.keys(orgRef).length === 0) {
    throw new Error(
      "Requires organizationId or one of organizationSlug, domain, or name",
    );
  }
  const body = {
    organizations: [orgRef],
    select: { attributes: ["id", "slug"] },
  };
  const parsedResponse = parseResponse(
    SumbleOrganizationsResponse,
    await sumblePost(config, "/organizations", body, signal),
    "organizations",
  );
  const row = (parsedResponse.organizations ?? [])[0];
  const flat = flattenOrgRow(row);
  const id = flat?.id;
  if (typeof id !== "number") {
    throw new Error(
      "Could not resolve organization to a Sumble organization id",
    );
  }
  return id;
}

export function validateConfig(config: SumbleToolsConfig): void {
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
