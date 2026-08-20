// A minimal client for the workflow-run-authenticated routine-management
// surface a running Myra calls to list, create, update, and run-now the
// workbench's routines — the execution half of `@corbits/routines`'
// `createWorkflowRoutineRoutes` (`packages/routines/src/workflow-routine-routes.ts`),
// mounted at `/api/workflow-routines` alongside `/api/workflow-capabilities`
// and `/api/workflow-memory` — authenticated the same way, via a sidecar
// bearer token + run address, never a human browser session.
//
// This client never re-implements scheduling, cron, or launch logic —
// every call is a thin HTTP hop into `@corbits/routines`' own service,
// which owns all of that. Every response is arktype-parsed at the trust
// boundary; a transport, HTTP, or shape failure throws a plain `Error`,
// never a fabricated result.
import { type } from "arktype";

export interface RoutineToolClientConfig {
  /** The hub's plain HTTP origin — same value memory-tools' `hubMemoryUrl`
   * and capability-tools' `hubCapabilitiesUrl` reach the hub through. */
  readonly hubRoutinesUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The trigger a routine create/update call sends. Mirrors
 * `@corbits/routines`' own `RoutineTrigger` union
 * (`packages/routines/src/trigger.ts`) structurally rather than
 * importing it, so this bundle stays a thin HTTP client with no
 * dependency on the routines package's own validation internals — the
 * route on the other end (`RoutineTrigger` there) is still the single
 * source of truth on what's actually valid; a bad shape here comes back
 * as an honest 400, never silently accepted.
 */
export type RoutineTriggerInput =
  | {
      readonly kind: "daily";
      readonly hour: number;
      readonly minute: number;
      readonly timezone?: string;
    }
  | {
      readonly kind: "weekly";
      readonly dayOfWeek: number;
      readonly hour: number;
      readonly minute: number;
      readonly timezone?: string;
    }
  | {
      readonly kind: "cron";
      readonly expression: string;
      readonly timezone?: string;
    }
  | { readonly kind: "webhook"; readonly webhookTriggerId: string };

export interface RoutineView {
  readonly id: string;
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: unknown;
  readonly scope: string;
  readonly input: Record<string, unknown>;
  readonly enabled: boolean;
  readonly deliveryWorkbenchId: string | null;
  readonly consecutiveFailures: number;
  readonly deadLetteredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRoutineRequest {
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: RoutineTriggerInput;
  readonly input?: Record<string, unknown>;
  readonly deliveryWorkbenchId?: string;
  readonly runOnceNow?: boolean;
}

export interface UpdateRoutineRequest {
  readonly enabled?: boolean;
  readonly name?: string;
  readonly trigger?: RoutineTriggerInput;
  readonly input?: Record<string, unknown>;
}

export interface RunRoutineNowResult {
  readonly runId: string;
}

const RoutineViewResponse = type({
  id: "string",
  name: "string",
  definitionId: "string",
  trigger: "unknown",
  scope: "string",
  input: "Record<string, unknown>",
  enabled: "boolean",
  deliveryWorkbenchId: "string | null",
  consecutiveFailures: "number",
  deadLetteredAt: "string | null",
  createdAt: "string",
  updatedAt: "string",
});

const ListRoutinesResponse = type({
  items: RoutineViewResponse.array(),
});

const RunRoutineNowResponse = type({
  runId: "string",
});

/** Pulls `error.message` out of a Hono `app.onError` envelope
 * (`{error: {code, message}}`), if `body` matches that shape. */
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

function authHeaders(config: RoutineToolClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

function endpoint(config: RoutineToolClientConfig, path: string): string {
  return `${config.hubRoutinesUrl}/api/workflow-routines${path}`;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

/** Lists every routine in the calling run's own tenant. Throws a plain
 * `Error` on any transport, HTTP, or shape failure — never fabricates a
 * list. */
export async function listRoutines(
  config: RoutineToolClientConfig,
): Promise<readonly RoutineView[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/routines"), {
    headers: authHeaders(config),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Listing routines failed: ${response.status} ${response.statusText}`,
      ),
    );
  }
  const body: unknown = await response.json();
  const parsed = ListRoutinesResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Routine list response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.items;
}

/** Creates a routine, scoped `"bench"` by the route itself — Myra always
 * creates for the shared workbench, never a personal routine. Throws a
 * plain `Error` on any transport, HTTP, or shape failure — never
 * fabricates a created routine. */
export async function createRoutine(
  config: RoutineToolClientConfig,
  input: CreateRoutineRequest,
): Promise<RoutineView> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/routines"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Creating the routine failed: ${response.status} ${response.statusText}`,
      ),
    );
  }
  const body: unknown = await response.json();
  const parsed = RoutineViewResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Created-routine response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Updates a routine's `enabled`/`name`/`trigger`/`input`. Throws a
 * plain `Error` on any transport, HTTP, or shape failure. */
export async function updateRoutine(
  config: RoutineToolClientConfig,
  routineId: string,
  patch: UpdateRoutineRequest,
): Promise<RoutineView> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, `/routines/${routineId}`), {
    method: "PATCH",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Updating the routine failed: ${response.status} ${response.statusText}`,
      ),
    );
  }
  const body: unknown = await response.json();
  const parsed = RoutineViewResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Updated-routine response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Runs a routine now — the exact same launch-then-correlate path a
 * scheduled fire takes, just unscheduled. Throws a plain `Error` on any
 * transport, HTTP, or shape failure — never fabricates a run. */
export async function runRoutineNow(
  config: RoutineToolClientConfig,
  routineId: string,
  input?: Record<string, unknown>,
): Promise<RunRoutineNowResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    endpoint(config, `/routines/${routineId}/run`),
    {
      method: "POST",
      headers:
        input === undefined
          ? authHeaders(config)
          : { ...authHeaders(config), "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify({ input }),
    },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Running the routine failed: ${response.status} ${response.statusText}`,
      ),
    );
  }
  const body: unknown = await response.json();
  const parsed = RunRoutineNowResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Run-now response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}
