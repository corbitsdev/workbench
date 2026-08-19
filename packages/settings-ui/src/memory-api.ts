// Memory section seam to `apps/hub/src/memory-status.ts`'s read-only
// `GET /api/tenants/:tenantId/memory/status` — `connections-api.ts`-shaped:
// same fetch wrapper, same error class convention, arktype at the trust
// boundary. `packages/settings-ui` never imports `apps/hub`'s own module
// (apps depend on packages, never the reverse), so the contract's shape is
// mirrored here rather than shared; `apps/hub/src/memory-status.ts`'s
// exported types are the source of truth this schema must keep matching.

import { type } from "arktype";

import { apiRequest, type Validator } from "./api-request";

export class MemoryApiError extends Error {
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
): Promise<T> {
  return apiRequest(path, schema, verb, MemoryApiError);
}

const MemoryEmbedStatus = type({ model: "string", host: "string" }).or("null");

const MemoryRerankStatus = type({
  configured: "true",
  model: "string",
  host: "string",
}).or({ configured: "false" });

export const MemorySetupOption = type({
  kind: "'set-env'",
  label: "string",
  envVars: "string[]",
}).or({ kind: "'lexical-only'", label: "string", caveat: "string" });
export type MemorySetupOption = typeof MemorySetupOption.infer;

const MemoryDegradeStatus = type({
  totalSearches: "number",
  since: "string",
  windowSize: "number",
  windowedDegradeRate: "Record<string, number>",
  escalated: "Record<string, boolean>",
});

const MemoryPlaneStatusSchema = type({
  source: "'env' | 'lexical-only'",
  embeddingsConfigured: "boolean",
  embed: MemoryEmbedStatus,
  rerank: MemoryRerankStatus,
  degrade: MemoryDegradeStatus,
  missing: "string[]",
  setupOptions: MemorySetupOption.array(),
});
export type MemoryPlaneStatus = typeof MemoryPlaneStatusSchema.infer;

// Whether the person asking holds any memory under this org — a separate
// axis from whether the plane itself works, so a guest gets an explanation
// instead of the plane's own healthy report or the operator-facing
// infrastructure copy.
const MemoryCallerScopeSchema = type({ kind: "'scoped'" }).or({
  kind: "'unscoped'",
  reason: "'no-org-principal' | 'no-account-tenant' | 'not-a-person'",
});
export type MemoryCallerScope = typeof MemoryCallerScopeSchema.infer;

const MemoryStatusResponseSchema = type({
  plane: MemoryPlaneStatusSchema,
  caller: MemoryCallerScopeSchema,
});
export type MemoryStatusResponse = typeof MemoryStatusResponseSchema.infer;

export function fetchMemoryStatus(
  tenantId: string,
): Promise<MemoryStatusResponse> {
  return request(
    `/api/tenants/${tenantId}/memory/status`,
    MemoryStatusResponseSchema,
    "loading your memory status",
  );
}
