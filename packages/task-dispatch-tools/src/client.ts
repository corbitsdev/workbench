// A minimal client for the workflow-run-authenticated dispatch surface
// a running agent (Myra) calls to hand a task off to another agent —
// the execution half of `@corbits/task-planner`'s
// `createWorkflowDispatchRoutes` (`POST /dispatch`), mirroring
// `@corbits/capability-tools/client.ts` exactly: same auth-header
// pattern, same "throw an honest Error on any transport/HTTP/shape
// failure, never fabricate a result" contract.
//
// This surface is mounted in `apps/hub` at
// `/api/workflow-task-planner`, OUTSIDE the tenant-session prefix,
// authenticated the same way `@corbits/capability-tools/client.ts`
// reaches `/api/workflow-capabilities`: sidecar bearer token +
// `x-workflow-run-address` header, never a human browser session.
import { type } from "arktype";

export interface TaskDispatchClientConfig {
  /** The hub's plain HTTP origin — same value `@corbits/capability-tools`'
   * `hubCapabilitiesUrl` and `@corbits/memory-tools`' `hubMemoryUrl`
   * reach the hub through. */
  readonly hubTaskPlannerUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type DispatchTaskRequest = {
  readonly outcome: string;
  /** When given, the task launches immediately against this agent —
   * no planner re-ask. Omit to let the platform's own planner pick or
   * create a suitable agent. */
  readonly agentDefinitionId?: string;
};

export type DispatchTaskResult = {
  readonly taskId: string;
};

/** The route's honest "couldn't dispatch" 422 — a planning failure, a
 * create-bounds violation, a denied create grant, or any other
 * fail-closed rejection `createWorkflowDispatchRoutes` maps to plain
 * language. Distinguished from a bare transport/HTTP error so callers
 * can report honestly rather than guessing at the cause. */
export class TaskDispatchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskDispatchFailedError";
  }
}

const DispatchTaskResponse = type({
  taskId: "string",
});

function authHeaders(config: TaskDispatchClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Pulls `error.message` out of a Hono `app.onError`/error-envelope
 * response (`{error: {code, message}}`), if `body` matches that shape.
 * Copied verbatim from `@corbits/capability-tools/client.ts`. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }
  const message = (error as { message: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

/** Dispatches one task through the platform's sanctioned dispatch
 * machinery. Throws `TaskDispatchFailedError` on the route's
 * fail-closed 422, or a bare `Error` on any other transport/HTTP/shape
 * failure — never fabricates a `taskId`. */
export async function dispatchTask(
  config: TaskDispatchClientConfig,
  input: DispatchTaskRequest,
): Promise<DispatchTaskResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubTaskPlannerUrl}/api/workflow-task-planner/dispatch`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (response.status === 422 || response.status === 400) {
    const body: unknown = await response.json().catch(() => undefined);
    const message =
      errorMessageFrom(body) ?? "That task couldn't be dispatched.";
    throw new TaskDispatchFailedError(message);
  }
  if (!response.ok) {
    throw new Error(
      `Dispatching a task failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = DispatchTaskResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Dispatch response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}
