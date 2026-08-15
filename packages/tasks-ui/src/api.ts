// This UI's one seam to `@corbits/tasks`' HTTP routes (see
// packages/tasks/src/routes.ts) plus the tenant's dynamic model
// catalog (`GET /tenants/:id/catalog/models`, the platform's own
// route — see `vendor/intx/hub-api`), mirroring
// `apps/web/src/agents-api.ts`'s `listCatalogModels`. Every response
// is parsed with an arktype schema at the boundary.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

const TaskStatus = type(
  '"queued" | "running" | "needs-you" | "done" | "failed"',
);
export type TaskStatus = typeof TaskStatus.infer;

const Task = type({
  id: "string",
  definitionId: "string",
  prompt: "string",
  modelPreference: "string | null",
  status: TaskStatus,
  runId: "string",
  resultMailId: "string | null",
  createdAt: "string",
  completedAt: "string | null",
});
export type Task = typeof Task.infer;

const TaskResponse = type({ item: Task });
const TasksResponse = type({ items: Task.array() });

const CatalogModel = type({
  id: "string",
  tenantId: "string",
  canonicalName: "string",
  "displayName?": "string | null",
  "description?": "string | null",
  disabled: "boolean",
});
export type CatalogModel = typeof CatalogModel.infer;

const CatalogModelsPage = type({ data: CatalogModel.array() });

export class TasksApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TasksApiError";
  }
}

async function request<T>(
  path: string,
  schema: (input: unknown) => T | ArkErrors,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message ===
        "string"
        ? (body as { error: { message: string } }).error.message
        : `request to ${path} failed with ${String(response.status)}`;
    throw new TasksApiError(message, response.status);
  }
  const json = await response.json();
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new TasksApiError(`invalid response from ${path}: ${parsed.summary}`);
  }
  return parsed;
}

export function createTask(
  tenantId: string,
  input: {
    readonly definitionId: string;
    readonly prompt: string;
    readonly modelPreference?: string;
  },
): Promise<Task> {
  return request(`/api/tenants/${tenantId}/tasks`, TaskResponse, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((page) => page.item);
}

export function listTasks(tenantId: string): Promise<readonly Task[]> {
  return request(`/api/tenants/${tenantId}/tasks`, TasksResponse).then(
    (page) => page.items,
  );
}

export function getTask(tenantId: string, taskId: string): Promise<Task> {
  return request(`/api/tenants/${tenantId}/tasks/${taskId}`, TaskResponse).then(
    (page) => page.item,
  );
}

const CATALOG_PAGE_LIMIT = 200;

/** Only enabled models — mirrors `apps/web/src/agents-api.ts`'s own
 * filter. An empty result means the composer never shows a model
 * select, the same "hide when there's nothing to pick" rule
 * `create-agent-dialog.tsx` already established. */
export function listCatalogModels(
  tenantId: string,
): Promise<readonly CatalogModel[]> {
  return request(
    `/api/tenants/${tenantId}/catalog/models?limit=${String(CATALOG_PAGE_LIMIT)}`,
    CatalogModelsPage,
  ).then((page) => page.data.filter((model) => !model.disabled));
}
