// Credentials section seam to Interchange's native credential + provider
// routes. Secrets are write-only: list/get never return them; create
// accepts the secret once and the hub encrypts it.

import {
  CredentialResponse,
  ProviderResponse,
  paginatedSchema,
  type CredentialType,
} from "@intx/types";
export { credentialTypes } from "@intx/types";

import { apiRequest, type Validator } from "./api-request";

export type Credential = typeof CredentialResponse.infer;
export type Provider = typeof ProviderResponse.infer;

const CredentialsPage = paginatedSchema(CredentialResponse);
const ProvidersPage = paginatedSchema(ProviderResponse);

export class CredentialsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function request<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequest(path, schema, verb, CredentialsApiError, init);
}

export function listCredentials(tenantId: string): Promise<readonly Credential[]> {
  return request(
    `/api/tenants/${tenantId}/credentials`,
    CredentialsPage,
    "loading credentials",
  ).then((page) => page.data);
}

export function listProviders(tenantId: string): Promise<readonly Provider[]> {
  return request(`/api/tenants/${tenantId}/providers`, ProvidersPage, "loading providers").then(
    (page) => page.data,
  );
}

/** Mints a plain, non-inference provider row named after the credential
 * a person is about to store — the stock credentials route requires a
 * `providerId`, and a bare "add a key" form has no provider of its own
 * to point at yet. `plugin: "custom"` marks it as this form's own,
 * generic kind rather than an inference adapter. */
export function createProvider(tenantId: string, name: string): Promise<Provider> {
  return request(`/api/tenants/${tenantId}/providers`, ProviderResponse, "creating that provider", {
    method: "POST",
    body: JSON.stringify({ name, plugin: "custom" }),
  });
}

export type CreateCredentialInput = {
  readonly providerId: string;
  readonly name: string;
  readonly type: CredentialType;
  readonly secret: string;
  readonly description?: string;
};

export function createCredential(
  tenantId: string,
  input: CreateCredentialInput,
): Promise<Credential> {
  return request(
    `/api/tenants/${tenantId}/credentials`,
    CredentialResponse,
    "storing that credential",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteCredential(tenantId: string, credentialId: string): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/credentials/${credentialId}`,
    (data) => data as void,
    "revoking that credential",
    { method: "DELETE" },
  );
}

export type UpdateCredentialInput = {
  readonly name?: string;
  readonly description?: string;
  /** `baseURL`/`model` are this form's own convention for a local,
   * Ollama-style credential — the stock route stores whatever object is
   * sent here as opaque `metadata`, nothing more. */
  readonly metadata?: { readonly baseURL?: string; readonly model?: string };
};

export function updateCredential(
  tenantId: string,
  credentialId: string,
  input: UpdateCredentialInput,
): Promise<Credential> {
  return request(
    `/api/tenants/${tenantId}/credentials/${credentialId}`,
    CredentialResponse,
    "updating that credential",
    { method: "PATCH", body: JSON.stringify(input) },
  );
}
