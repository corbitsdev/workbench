// Reads a workbench template's manifest from the bench library the hub
// seeded at boot (CL-6344) — `instant-agent-create.ts` instantiates
// from this seeded row, never from a hardcoded `@corbits/workflow-catalog`
// import. The wire shape is the library's `{id, content}` entry; the
// content string re-enters through the catalog's own manifest schema,
// so a corrupt or stale library row fails loud here rather than
// half-instantiating a workbench.

import { type } from "arktype";
import {
  parseWorkbenchTemplateManifest,
  type WorkbenchTemplateManifest,
} from "@corbits/workflow-catalog";
import { ApiQueryError } from "@corbits/api-query";

const TemplateLibraryEntry = type({ id: "string > 0", content: "string > 0" });

/**
 * The seeded manifest for `templateId`, or null when the library has no
 * such entry (a bench whose boot seed hasn't run yet — the caller
 * decides whether that's fatal for the template being created).
 */
export async function fetchWorkbenchTemplateManifest(
  tenantId: string,
  templateId: string,
): Promise<WorkbenchTemplateManifest | null> {
  const path = `/api/tenants/${tenantId}/library/templates/${templateId}`;
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      path,
    );
  }
  const entry = TemplateLibraryEntry(
    await response.json().catch(() => undefined),
  );
  if (entry instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected template entry shape: ${entry.summary}`,
      undefined,
      path,
    );
  }
  return parseWorkbenchTemplateManifest(entry.content);
}
