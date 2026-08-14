// Browser client for @corbits/bench's tenant-scoped routes. Apps stay
// generic (AGENTS.md): the fetch/parse logic for hitting
// `/api/tenants/:id/bench-settings` is domain logic that lives here, not in
// `packages/bench-ui` or `packages/settings-ui`.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

const BenchSettingsResponse = type({
  purpose: "string | null",
  type: "string | null",
});
export type BenchSettingsResponse = typeof BenchSettingsResponse.infer;

export class BenchSettingsApiError extends Error {
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
    throw new BenchSettingsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new BenchSettingsApiError(`Not signed in for ${path}.`, 401);
  }
  if (!response.ok) {
    throw new BenchSettingsApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new BenchSettingsApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

function benchSettingsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/bench-settings`;
}

export function getBenchSettings(
  tenantId: string,
): Promise<BenchSettingsResponse> {
  return request(benchSettingsPath(tenantId), BenchSettingsResponse);
}

export type BenchSettingsPatch = {
  readonly purpose?: string;
  readonly type?: "global" | "sub";
};

export function patchBenchSettings(
  tenantId: string,
  patch: BenchSettingsPatch,
): Promise<BenchSettingsResponse> {
  return request(benchSettingsPath(tenantId), BenchSettingsResponse, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
