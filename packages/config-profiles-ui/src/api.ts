// Browser-side wire client for `./routes.ts`, the same shape
// `@corbits/inference-settings`'s own `api.ts` and `@corbits/settings-ui`'s
// per-section `*-api.ts` files use: a thin `fetch` + arktype-parse
// wrapper, one typed error class, and one function per route.
import { type } from "arktype";
import { UnauthenticatedError } from "@corbits/api-query";

export class ConfigProfilesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const ConfigProfileEntry = type({
  provider: "string",
  model: "string",
  "disabled?": "boolean",
});
export type ConfigProfileEntry = typeof ConfigProfileEntry.infer;

const ConfigProfileView = type({
  id: "string",
  name: "string",
  description: "string | null",
  entries: ConfigProfileEntry.array(),
  createdAt: "string",
  updatedAt: "string",
});
export type ConfigProfile = typeof ConfigProfileView.infer;

const ApplyEntryResult = type({
  provider: "string",
  model: "string",
  action:
    "'reordered' | 'skipped-inherited' | 'skipped-unavailable' | 'failed' | 'not-attempted'",
  "offeringId?": "string",
  "priority?": "number",
  "disabled?": "boolean",
  "message?": "string",
  "status?": "number",
});
export type ApplyEntryResult = typeof ApplyEntryResult.infer;

const ApplyProfileResponse = type({
  profileId: "string",
  profileName: "string",
  ok: "boolean",
  results: ApplyEntryResult.array(),
});
export type ApplyProfileResponse = typeof ApplyProfileResponse.infer;

const PlanProfileResponse = type({
  profileId: "string",
  profileName: "string",
  results: ApplyEntryResult.array(),
});
export type PlanProfileResponse = typeof PlanProfileResponse.infer;

type Validator<T> = (data: unknown) => T | type.errors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ConfigProfilesApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = type({ error: { message: "string" } })(body);
    throw new ConfigProfilesApiError(
      envelope instanceof type.errors
        ? `The server answered ${response.status} while ${verb}.`
        : envelope.error.message,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ConfigProfilesApiError(
      `Unexpected response shape while ${verb}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export async function listProfiles(
  tenantId: string,
): Promise<readonly ConfigProfile[]> {
  const page = await request(
    `/api/tenants/${tenantId}/config-profiles`,
    type({ items: ConfigProfileView.array() }),
    "loading profiles",
  );
  return page.items;
}

export type CreateProfileInput = {
  readonly name: string;
  readonly description?: string;
  readonly entries: readonly ConfigProfileEntry[];
};

export function createProfile(
  tenantId: string,
  input: CreateProfileInput,
): Promise<ConfigProfile> {
  return request(
    `/api/tenants/${tenantId}/config-profiles`,
    ConfigProfileView,
    "creating that profile",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export type UpdateProfileInput = {
  readonly name?: string;
  readonly description?: string | null;
  readonly entries?: readonly ConfigProfileEntry[];
};

export function updateProfile(
  tenantId: string,
  profileId: string,
  patch: UpdateProfileInput,
): Promise<ConfigProfile> {
  return request(
    `/api/tenants/${tenantId}/config-profiles/${profileId}`,
    ConfigProfileView,
    "saving that profile",
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function deleteProfile(
  tenantId: string,
  profileId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/config-profiles/${profileId}`,
    (data) => data as void,
    "deleting that profile",
    { method: "DELETE" },
  );
}

export function captureProfile(
  tenantId: string,
  input: {
    readonly targetTenantId: string;
    readonly name: string;
    readonly description?: string;
  },
): Promise<ConfigProfile> {
  return request(
    `/api/tenants/${tenantId}/config-profiles/capture`,
    ConfigProfileView,
    "saving this workbench's setup as a profile",
    { method: "POST", body: JSON.stringify(input) },
  );
}

/** Read-only dry run of `applyProfile`: the same per-entry plan, no write
 * ever issued. Backs `ApplyProfilePanel`'s honest, per-entry preview. */
export function planProfile(
  tenantId: string,
  profileId: string,
  input: { readonly targetTenantId: string },
): Promise<PlanProfileResponse> {
  return request(
    `/api/tenants/${tenantId}/config-profiles/${profileId}/plan`,
    PlanProfileResponse,
    "loading that profile's plan",
    { method: "POST", body: JSON.stringify(input) },
  );
}

/**
 * Applying a profile can partially fail: the server stops issuing writes
 * the moment one PATCH fails, and reports every entry's own outcome —
 * `"reordered"` for what already succeeded, `"failed"` for the one that
 * broke, `"not-attempted"` for what never got a turn. That response comes
 * back with a non-2xx status (502) precisely when `ok` is `false`, so this
 * bypasses the generic `request` helper (which treats any non-2xx as an
 * opaque error with no body) and parses the response body first — only
 * falling back to the error envelope shape when the body isn't a
 * recognizable apply result at all (e.g. the 403/404 this route can also
 * answer with).
 */
export async function applyProfile(
  tenantId: string,
  input: { readonly profileId: string; readonly targetTenantId: string },
): Promise<ApplyProfileResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/tenants/${tenantId}/config-profiles/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    throw new ConfigProfilesApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ApplyProfileResponse(body);
  if (!(parsed instanceof type.errors)) return parsed;
  const envelope = type({ error: { message: "string" } })(body);
  throw new ConfigProfilesApiError(
    envelope instanceof type.errors
      ? `The server answered ${response.status} while applying that profile.`
      : envelope.error.message,
    response.status,
  );
}
