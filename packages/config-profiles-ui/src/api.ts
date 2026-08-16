// Browser-side wire client for `./routes.ts`, the same shape
// `@corbits/inference-settings`'s own `api.ts` and `@corbits/settings-ui`'s
// per-section `*-api.ts` files use: a thin `fetch` + arktype-parse
// wrapper, one typed error class, and one function per route.
import { type } from "arktype";

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
  action: "'reordered' | 'skipped-inherited' | 'skipped-unavailable'",
  "offeringId?": "string",
  "priority?": "number",
  "disabled?": "boolean",
});
export type ApplyEntryResult = typeof ApplyEntryResult.infer;

const ApplyProfileResponse = type({
  profileId: "string",
  profileName: "string",
  results: ApplyEntryResult.array(),
});
export type ApplyProfileResponse = typeof ApplyProfileResponse.infer;

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
    readonly workbenchTenantId: string;
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

export function applyProfile(
  tenantId: string,
  input: { readonly profileId: string; readonly workbenchTenantId: string },
): Promise<ApplyProfileResponse> {
  return request(
    `/api/tenants/${tenantId}/config-profiles/apply`,
    ApplyProfileResponse,
    "applying that profile",
    { method: "POST", body: JSON.stringify(input) },
  );
}
