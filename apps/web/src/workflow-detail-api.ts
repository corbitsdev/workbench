// The workflow detail page's one seam to the hub's read route
// (`@corbits/workflow-catalog/detail-route.ts`, mounted at
// `${TENANT_PREFIX}/workflows/definitions/:definitionAssetId/detail` in
// `apps/hub/src/index.ts`). Wire schema and pure display helpers live in
// `@corbits/workflow-catalog`, browser-safe like `routines-api.ts`'s own
// definitions listing — this file is fetch composition only.
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { ApiQueryError, UnauthenticatedError } from "@corbits/api-query";
import { WorkflowDefinitionDetail } from "@corbits/workflow-catalog";
import type { WorkflowDefinitionDetail as WorkflowDefinitionDetailT } from "@corbits/workflow-catalog";

export type { WorkflowDefinitionDetail as WorkflowDefinitionDetailT } from "@corbits/workflow-catalog";
export {
  workflowDetailPath,
  workflowNotLaunchableReason,
} from "@corbits/workflow-catalog";

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
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

export function getWorkflowDefinitionDetail(
  tenantId: string,
  definitionAssetId: string,
): Promise<WorkflowDefinitionDetailT> {
  return request(
    `/api/tenants/${tenantId}/workflows/definitions/${encodeURIComponent(definitionAssetId)}/detail`,
    WorkflowDefinitionDetail,
  );
}
