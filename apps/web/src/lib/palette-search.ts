import { type } from "arktype";
import {
  PaletteSearchResponseSchema,
  type PaletteSearchResponse,
} from "@workbench/shared";
import { buildRootUrl } from "./api";

/**
 * Fetch one page of the server-side aggregate palette search for a tenant. The
 * endpoint lives at `/api/tenants/:tenantId/search` (outside the `/api/v1`
 * prefix `api()` uses), so it goes through `buildRootUrl`. The response is
 * validated through the shared arktype schema at this trust boundary.
 */
export async function searchPaletteEntities(
  tenantId: string,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<PaletteSearchResponse> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const url = buildRootUrl(
    `api/tenants/${encodeURIComponent(tenantId)}/search?${params.toString()}`,
  );
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) {
    throw new Error(`Search request failed (HTTP ${res.status})`);
  }
  const raw: unknown = await res.json();
  const parsed = PaletteSearchResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected search response: ${parsed.summary}`);
  }
  return parsed;
}
