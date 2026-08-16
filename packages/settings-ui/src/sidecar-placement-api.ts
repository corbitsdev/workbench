// The "run this workbench on its own sidecar" toggle's one seam to
// @corbits/sidecar-placement's tenant-scoped route. Same request/parse
// convention as tenancy-api.ts: every response is arktype-validated at
// the boundary.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

const SidecarPlacementResponse = type({
  enabled: "boolean",
  provisionerAvailable: "boolean",
});

export type SidecarPlacementResult = typeof SidecarPlacementResponse.infer;

export class SidecarPlacementApiError extends Error {
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
): Promise<SidecarPlacementResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new SidecarPlacementApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new SidecarPlacementApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed: typeof SidecarPlacementResponse.infer | ArkErrors =
    SidecarPlacementResponse(body);
  if (parsed instanceof type.errors) {
    throw new SidecarPlacementApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function getSidecarPlacement(
  tenantId: string,
): Promise<SidecarPlacementResult> {
  return request(`/api/tenants/${tenantId}/sidecar-placement`);
}

export function setSidecarPlacement(
  tenantId: string,
  enabled: boolean,
): Promise<SidecarPlacementResult> {
  return request(`/api/tenants/${tenantId}/sidecar-placement`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}
