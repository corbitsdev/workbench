// Capacity section seam onto @corbits/sidecar-placement's tenant-scoped
// route. Same shape as @corbits/settings-ui's old sidecar-placement-api.ts
// (CL-6096) — chat-ui cannot import that package (settings-ui depends on
// chat-ui, not the other way around), so this is its own small client
// against the same route rather than a shared one.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

const CapacityResponse = type({
  enabled: "boolean",
  provisionerAvailable: "boolean",
});

export type CapacityResult = typeof CapacityResponse.infer;

export class CapacityApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request(
  path: string,
  init?: RequestInit,
): Promise<CapacityResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new CapacityApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new CapacityApiError(
      `The server answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed: typeof CapacityResponse.infer | ArkErrors = CapacityResponse(
    body,
  );
  if (parsed instanceof type.errors) {
    throw new CapacityApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function getCapacityPlacement(
  tenantId: string,
): Promise<CapacityResult> {
  return request(`/api/tenants/${tenantId}/sidecar-placement`);
}

export function setCapacityPlacement(
  tenantId: string,
  enabled: boolean,
): Promise<CapacityResult> {
  return request(`/api/tenants/${tenantId}/sidecar-placement`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}
