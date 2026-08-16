// The Inference settings section's one seam onto the native catalog and
// credential routes (`vendor/intx/hub-api/src/routes/{models,model-offerings,
// model-providers,providers,credentials}.ts`). There is no bespoke workbench
// route here: every read and write below hits a route Interchange's own
// catalog resolution (`resolveModelSources` / `listVisibleOfferings`,
// `vendor/intx/db/src/{model-source-resolution,catalog-resolution}.ts`)
// already reads or honors —
//
//   - `GET /api/tenants/:id/models` is the resolved, ancestor-inherited
//     catalog (`createModelDiscoveryRoutes`): the same offerings, in the
//     same priority order, `resolveModelSources` would try at launch.
//   - `GET /api/tenants/:id/catalog/offerings` lists only the offerings
//     this exact tenant owns directly — diffed against the resolved list,
//     an offering id present here is "set here"; absent, "inherited".
//   - `PATCH /api/tenants/:id/catalog/offerings/:offeringId` (priority,
//     disabled) is the exact write `byPriority`'s ordering and
//     `listVisibleOfferings`'s disable-cascade both read — this is the
//     real, tenant-scoped, resolution-honored reorder/restrict, not a
//     parallel store.
//
// Overriding an *inherited* offering for this workbench needs a
// tenant-owned model + provider + offering triple (the offering's
// identity is `(model canonicalName, provider name)` — see
// `vendor/intx/db/src/catalog-resolution.ts`'s module doc): a child
// tenant cannot reuse an ancestor's model-provider row directly because
// its `credentialId` is not fetchable from a descendant tenant context
// (`GET /catalog/providers/:id` filters to `tenantId = tenantCtx.id`), so
// `shadowOffering` below always mints this tenant's own credential first
// (bring-your-own-key), then the model/provider/offering copies that
// reference it — never the ancestor's credential.

import { type } from "arktype";
import {
  CreateCredential,
  CreateModel,
  CreateModelOffering,
  CreateModelProvider,
  CreateProvider,
  CredentialResponse,
  ModelInfo,
  ModelOfferingResponse,
  ModelProviderPlugin,
  ModelProviderResponse,
  ModelResponse,
  ProviderResponse,
  UpdateModelOffering,
  paginatedSchema,
} from "@intx/types";

export type { ModelInfo, ModelOfferingInfo } from "@intx/types";

export class InferenceSettingsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

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
    throw new InferenceSettingsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = type({ error: { message: "string" } })(body);
    throw new InferenceSettingsApiError(
      envelope instanceof type.errors
        ? `The server answered ${response.status} while ${verb}.`
        : envelope.error.message,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new InferenceSettingsApiError(
      `Unexpected response shape while ${verb}: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** For a route whose success response is `204 No Content` — nothing to
 * validate against a schema, so this is the one place a call is allowed
 * to end without a parsed body, rather than every `request<T>` caller
 * having to accept an unsound `undefined as T`. */
async function requestVoid(
  path: string,
  verb: string,
  init?: RequestInit,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new InferenceSettingsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = type({ error: { message: "string" } })(body);
    throw new InferenceSettingsApiError(
      envelope instanceof type.errors
        ? `The server answered ${response.status} while ${verb}.`
        : envelope.error.message,
      response.status,
    );
  }
}

/** The tenant's resolved catalog — every model visible after inheritance,
 * shadowing, and disable suppression, each with its offerings in
 * resolution-priority order. The same read `resolveModelSources` would
 * act on at launch. */
export function getResolvedCatalog(
  tenantId: string,
): Promise<readonly ModelInfo[]> {
  return request(
    `/api/tenants/${tenantId}/models`,
    ModelInfo.array(),
    "loading the model catalog",
  );
}

/** This tenant's own model rows, by id — used to label a restricted
 * offering with its model's display name rather than the raw offering
 * id. A restricted (disabled) offering never appears in
 * `getResolvedCatalog`'s resolved read (it is cascaded out, not merely
 * flagged there), so its model/provider names cannot be read off that
 * list the way a visible row's can. */
export async function listOwnModels(
  tenantId: string,
): Promise<readonly (typeof ModelResponse.infer)[]> {
  const page = await request(
    `/api/tenants/${tenantId}/catalog/models`,
    paginatedSchema(ModelResponse),
    "loading this workbench's own models",
  );
  return page.data;
}

/** This tenant's own model-provider rows, by id — the provider-name
 * counterpart to {@link listOwnModels}. */
export async function listOwnModelProviders(
  tenantId: string,
): Promise<readonly (typeof ModelProviderResponse.infer)[]> {
  const page = await request(
    `/api/tenants/${tenantId}/catalog/providers`,
    paginatedSchema(ModelProviderResponse),
    "loading this workbench's own catalog providers",
  );
  return page.data;
}

/** The offering rows this exact tenant owns directly (never an inherited
 * row) — including any this tenant has restricted (`disabled: true`),
 * which `getResolvedCatalog`'s resolved read never includes (a disabled
 * offering is cascaded out of resolution, not merely flagged). The
 * provenance source `getResolvedCatalog`'s flattened rows are diffed
 * against this list's ids; the disabled subset backs the "restricted
 * here" list a caller offers to re-enable. */
export async function listOwnOfferings(
  tenantId: string,
): Promise<readonly (typeof ModelOfferingResponse.infer)[]> {
  const page = await request(
    `/api/tenants/${tenantId}/catalog/offerings`,
    paginatedSchema(ModelOfferingResponse),
    "loading this workbench's own offerings",
  );
  return page.data;
}

/** Reorders or restricts an offering this tenant already owns directly.
 * Only a "set here" offering id is ever passed a `disabled` toggle or a
 * new `priority` — an inherited offering must be shadowed first
 * (`shadowOffering`), the same rule the native route itself enforces
 * (its `PATCH` scopes the update to `tenantId = tenantCtx.id` and 404s
 * otherwise). */
export function updateOwnOffering(
  tenantId: string,
  offeringId: string,
  patch: typeof UpdateModelOffering.infer,
): Promise<typeof ModelOfferingResponse.infer> {
  return request(
    `/api/tenants/${tenantId}/catalog/offerings/${offeringId}`,
    ModelOfferingResponse,
    "reordering this workbench's fallback list",
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export type ShadowOfferingInput = {
  readonly canonicalName: string;
  readonly modelDisplayName: string | null;
  readonly providerName: string;
  readonly plugin: typeof ModelProviderPlugin.infer;
  readonly baseURL: string;
  readonly apiKey: string;
  /** The exact priority of the offering being shadowed — this row takes
   * over its slot in resolution (`listVisibleOfferings`'s leaf-wins-by-name
   * cascade), so it must sort exactly where that offering did, never
   * appended at the end of the visible list. */
  readonly priority: number;
};

/**
 * Brings a workbench's own key for an *inherited* offering, so it becomes
 * this tenant's own and can be reordered/restricted directly. Mints a
 * tenant-owned credential (never reuses the ancestor's — see this file's
 * module doc for why that is not even reachable from here), then a
 * tenant-local model and model-provider that reference it, then the
 * offering itself. Each step tolerates the row already existing
 * (idempotent, mirroring `@workbench/hub-client`'s `seedCatalog` helpers)
 * so retrying a partial failure never 409s the whole flow.
 *
 * Order matters beyond idempotency: creating this tenant's model-provider
 * row is the moment every offering this tenant can already see under that
 * provider *name* re-routes through it — `listVisibleOfferings`
 * (`vendor/intx/db/src/catalog-resolution.ts`) resolves an offering's
 * provider by name across the whole ancestor chain, leaf wins, so a new
 * same-named provider becomes every inherited offering's provider the
 * instant it exists, not just the one being shadowed here. The model and
 * credential steps run first because neither has that blast radius on
 * their own (an unused model or credential nothing points at yet changes
 * no resolution). The provider is minted right before the offering that
 * justifies it, and if the offering step then fails, the freshly-minted
 * provider is deleted to undo the re-route rather than leaving it live
 * with no completing offering.
 */
export async function shadowOffering(
  tenantId: string,
  input: ShadowOfferingInput,
): Promise<typeof ModelOfferingResponse.infer> {
  const modelId = await ensureModel(
    tenantId,
    input.canonicalName,
    input.modelDisplayName,
  );
  const credentialId = await ensureCredential(tenantId, input);
  const { providerId, minted } = await ensureModelProvider(
    tenantId,
    input,
    credentialId,
  );
  try {
    return await ensureOffering(tenantId, modelId, providerId, input.priority);
  } catch (cause) {
    if (minted) {
      await requestVoid(
        `/api/tenants/${tenantId}/catalog/providers/${providerId}`,
        "rolling back the just-minted provider",
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    throw cause;
  }
}

async function ensureModel(
  tenantId: string,
  canonicalName: string,
  displayName: string | null,
): Promise<string> {
  const created = await fetch(`/api/tenants/${tenantId}/catalog/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CreateModel.assert({ canonicalName, displayName })),
  });
  if (created.status === 201) {
    const body: unknown = await created.json();
    return ModelResponse.assert(body).id;
  }
  if (created.status !== 409) {
    throw new InferenceSettingsApiError(
      `Couldn't create this workbench's own copy of ${canonicalName} (${String(created.status)}).`,
      created.status,
    );
  }
  const page = await request(
    `/api/tenants/${tenantId}/catalog/models`,
    paginatedSchema(ModelResponse),
    "loading this workbench's own models",
  );
  const existing = page.data.find((row) => row.canonicalName === canonicalName);
  if (existing === undefined) {
    throw new InferenceSettingsApiError(
      `${canonicalName} reported a name conflict but is not listed on this workbench.`,
    );
  }
  return existing.id;
}

async function ensureCredential(
  tenantId: string,
  input: ShadowOfferingInput,
): Promise<string> {
  const providerRow = await ensureCredentialProvider(tenantId, input);
  const credentialName = `${input.providerName}-workbench`;
  const created = await fetch(`/api/tenants/${tenantId}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      CreateCredential.assert({
        providerId: providerRow,
        name: credentialName,
        type: "api_key",
        secret: input.apiKey,
      }),
    ),
  });
  if (created.status === 201) {
    const body: unknown = await created.json();
    return CredentialResponse.assert(body).id;
  }
  if (created.status !== 409) {
    throw new InferenceSettingsApiError(
      `Couldn't store this workbench's key for ${input.providerName} (${String(created.status)}).`,
      created.status,
    );
  }
  // A credential name is unique per tenant, not per provider — retrying a
  // partial shadow attempt (the earlier POST stored the credential but a
  // later step failed) must resolve the row it already made rather than
  // dying on the same conflict every one of the other ensure* steps
  // already tolerates.
  const page = await request(
    `/api/tenants/${tenantId}/credentials`,
    paginatedSchema(CredentialResponse),
    "loading this workbench's own credentials",
  );
  const existing = page.data.find((row) => row.name === credentialName);
  if (existing === undefined) {
    throw new InferenceSettingsApiError(
      `${input.providerName}'s key reported a name conflict but is not listed on this workbench.`,
    );
  }
  return existing.id;
}

async function ensureCredentialProvider(
  tenantId: string,
  input: ShadowOfferingInput,
): Promise<string> {
  const created = await fetch(`/api/tenants/${tenantId}/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      CreateProvider.assert({
        name: input.providerName,
        plugin: input.plugin,
      }),
    ),
  });
  if (created.status === 201) {
    const body: unknown = await created.json();
    return ProviderResponse.assert(body).id;
  }
  if (created.status !== 409) {
    throw new InferenceSettingsApiError(
      `Couldn't register ${input.providerName} for this workbench (${String(created.status)}).`,
      created.status,
    );
  }
  const page = await request(
    `/api/tenants/${tenantId}/providers`,
    paginatedSchema(ProviderResponse),
    "loading this workbench's own providers",
  );
  const existing = page.data.find((row) => row.name === input.providerName);
  if (existing === undefined) {
    throw new InferenceSettingsApiError(
      `${input.providerName} reported a name conflict but is not listed on this workbench.`,
    );
  }
  return existing.id;
}

type EnsureModelProviderResult = {
  readonly providerId: string;
  /** True when this call created the row; false when it resolved one that
   * already existed (a 409 retry). Only a freshly-minted provider is safe
   * to roll back on a later step's failure — an already-existing provider
   * predates this call and other offerings may already depend on it. */
  readonly minted: boolean;
};

async function ensureModelProvider(
  tenantId: string,
  input: ShadowOfferingInput,
  credentialId: string,
): Promise<EnsureModelProviderResult> {
  const created = await fetch(`/api/tenants/${tenantId}/catalog/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      CreateModelProvider.assert({
        name: input.providerName,
        plugin: input.plugin,
        baseURL: input.baseURL,
        credentialId,
      }),
    ),
  });
  if (created.status === 201) {
    const body: unknown = await created.json();
    return { providerId: ModelProviderResponse.assert(body).id, minted: true };
  }
  if (created.status !== 409) {
    throw new InferenceSettingsApiError(
      `Couldn't create this workbench's own ${input.providerName} catalog entry (${String(created.status)}).`,
      created.status,
    );
  }
  const page = await request(
    `/api/tenants/${tenantId}/catalog/providers`,
    paginatedSchema(ModelProviderResponse),
    "loading this workbench's own catalog providers",
  );
  const existing = page.data.find((row) => row.name === input.providerName);
  if (existing === undefined) {
    throw new InferenceSettingsApiError(
      `${input.providerName} reported a name conflict but is not listed on this workbench's catalog.`,
    );
  }
  return { providerId: existing.id, minted: false };
}

async function ensureOffering(
  tenantId: string,
  modelId: string,
  providerId: string,
  priority: number,
): Promise<typeof ModelOfferingResponse.infer> {
  const created = await fetch(`/api/tenants/${tenantId}/catalog/offerings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      CreateModelOffering.assert({ modelId, providerId, priority }),
    ),
  });
  if (created.status === 201) {
    const body: unknown = await created.json();
    return ModelOfferingResponse.assert(body);
  }
  if (created.status !== 409) {
    throw new InferenceSettingsApiError(
      `Couldn't add this workbench's offering to the catalog (${String(created.status)}).`,
      created.status,
    );
  }
  const page = await request(
    `/api/tenants/${tenantId}/catalog/offerings`,
    paginatedSchema(ModelOfferingResponse),
    "loading this workbench's own offerings",
  );
  const existing = page.data.find(
    (row) => row.modelId === modelId && row.providerId === providerId,
  );
  if (existing === undefined) {
    throw new InferenceSettingsApiError(
      "This offering reported a conflict but is not listed on this workbench.",
    );
  }
  return existing;
}
