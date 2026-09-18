// The workflow detail page's one seam to reading a definition. There is
// no `GET .../:id` route, stock or otherwise
// (`vendor/intx/hub-api/src/routes/workflow-definitions.ts` only lists,
// lists versions, and rolls back), so this walks the stock list a page
// at a time and stops at the matching id. Wire schema and pure display
// helpers live in
// `@corbits/workflows/client`, browser-safe like `routines-api.ts`'s own
// definitions listing — this file is fetch composition only.
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { ApiQueryError, UnauthenticatedError } from "@/lib/api-query";
import { WorkflowDefinitionDetail } from "@corbits/workflows/client";
import type { WorkflowDefinitionDetail as WorkflowDefinitionDetailT } from "@corbits/workflows/client";

export type { WorkflowDefinitionDetail as WorkflowDefinitionDetailT } from "@corbits/workflows/client";
export { workflowDetailPath, workflowNotLaunchableReason } from "@corbits/workflows/client";

const StockWorkflowDefinition = type({
  id: "string",
  "description?": "string | null",
  name: "string",
  currentVersion: "string",
  status: "'deployed' | 'stopped'",
  createdAt: "string",
  updatedAt: "string",
});

const StockWorkflowDefinitionsPage = type({
  data: StockWorkflowDefinition.array(),
  nextCursor: "string | null",
});

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(path: string, schema: Validator<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "content-type": "application/json" },
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then(
        (body: { error?: { userMessage?: string; message?: string } }) =>
          body.error?.userMessage ?? body.error?.message ?? "",
      )
      .catch(() => "");
    throw new ApiQueryError(
      detail === "" ? `The server answered ${response.status}.` : detail,
      response.status,
      path,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

const MAX_PAGES_SCANNED = 20;

export async function getWorkflowDefinitionDetail(
  tenantId: string,
  definitionId: string,
): Promise<WorkflowDefinitionDetailT> {
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_PAGES_SCANNED; page += 1) {
    const query = cursor != null ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const listPath = `/api/tenants/${tenantId}/workflows/definitions${query}`;
    const body = await request(listPath, StockWorkflowDefinitionsPage);
    const found = body.data.find((item) => item.id === definitionId);
    if (found !== undefined) {
      const detail: WorkflowDefinitionDetailT = {
        definitionId: found.id,
        name: found.name,
        status: found.status,
        currentVersion: found.currentVersion,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
        ...(found.description !== undefined && found.description !== null
          ? { description: found.description }
          : {}),
      };
      const parsed = WorkflowDefinitionDetail(detail);
      if (parsed instanceof type.errors) {
        throw new ApiQueryError(
          `Unexpected response shape: ${parsed.summary}`,
          undefined,
          listPath,
        );
      }
      return parsed;
    }
    if (body.nextCursor == null) break;
    cursor = body.nextCursor;
  }
  throw new ApiQueryError("Workflow not found.", 404, definitionId);
}
