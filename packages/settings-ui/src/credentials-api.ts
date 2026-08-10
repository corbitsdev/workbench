// Credentials section seam to Interchange's native credential + provider
// routes. Secrets are write-only: list/get never return them; create
// accepts the secret once and the hub encrypts it.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import {
  CredentialResponse,
  ProviderResponse,
  paginatedSchema,
  type CredentialType,
} from "@intx/types";

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

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new CredentialsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new CredentialsApiError(`Not signed in for ${path}.`, 401);
  }
  if (response.status === 403) {
    throw new CredentialsApiError(`Not permitted to view ${path}.`, 403);
  }
  if (!response.ok) {
    throw new CredentialsApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new CredentialsApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function listCredentials(
  tenantId: string,
): Promise<readonly Credential[]> {
  return request(`/api/tenants/${tenantId}/credentials`, CredentialsPage).then(
    (page) => page.data,
  );
}

export function listProviders(tenantId: string): Promise<readonly Provider[]> {
  return request(`/api/tenants/${tenantId}/providers`, ProvidersPage).then(
    (page) => page.data,
  );
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
  return request(`/api/tenants/${tenantId}/credentials`, CredentialResponse, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteCredential(
  tenantId: string,
  credentialId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/credentials/${credentialId}`,
    (data) => data as void,
    { method: "DELETE" },
  );
}
