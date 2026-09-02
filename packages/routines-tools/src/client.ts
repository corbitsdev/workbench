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
import {
  Routine,
  RoutineTargetsResponse,
  type RoutineTriggerT,
} from "@corbits/routines/client";

export interface RoutineToolClientConfig {
  /** The hub's plain HTTP origin — same value memory-tools' `hubMemoryUrl`
   * and capability-tools' `hubCapabilitiesUrl` reach the hub through. */
  readonly hubRoutinesUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The trigger a routine create/update call sends — `@corbits/routines`'
 * own strict `RoutineTrigger` shape (`packages/routines/src/trigger.ts`),
 * re-exported rather than duplicated: the route on the other end is
 * still the single source of truth on what's actually valid; a bad shape
 * here comes back as an honest 400, never silently accepted. */
export type RoutineTriggerInput = RoutineTriggerT;

/** A routine as this bundle reads it back — `@corbits/routines/client`'s
 * own wire shape, re-exported rather than duplicated. */
export type RoutineView = typeof Routine.infer;

export interface CreateRoutineRequest {
  readonly name: string;
  /** The workflow asset this routine runs — see `CreateRoutineInput`'s
   * own doc comment in `@corbits/routines/client`. */
  readonly definitionAssetId: string;
  readonly trigger: RoutineTriggerInput;
  readonly input?: Record<string, unknown>;
  readonly deliveryWorkbenchId?: string;
  readonly runOnceNow?: boolean;
}

export interface UpdateRoutineRequest {
  readonly enabled?: boolean;
  readonly name?: string;
  /** Retargets the routine at a different workflow asset — see
   * `CreateRoutineRequest.definitionAssetId`'s own doc comment. */
  readonly definitionAssetId?: string;
  readonly trigger?: RoutineTriggerInput;
  readonly input?: Record<string, unknown>;
}

export interface RunRoutineNowResult {
  readonly runId: string;
}

/** A target this bundle reads back — `@corbits/routines/client`'s own
 * wire shape, re-exported rather than duplicated. */
export type RoutineTargetView = RoutineTargetsResponse["items"][number];

const RoutineViewResponse = Routine;

const ListRoutinesResponse = type({
  items: RoutineViewResponse.array(),
});

const RunRoutineNowResponse = type({
  runId: "string",
});

/** Pulls `error.userMessage` out of the canonical hub envelope
 * (`{error: {code, userMessage, refId}}`), if `body` matches that shape. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (
    error === null ||
    typeof error !== "object" ||
    !("userMessage" in error)
  ) {
    return undefined;
  }
  const userMessage = (error as { userMessage: unknown }).userMessage;
  return typeof userMessage === "string" ? userMessage : undefined;
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

/** Lists the launchable workflow definitions/agents the calling run's
 * tenant offers as a routine target — the same `listRoutineTargets`
 * (`@corbits/routines/src/targets.ts`) the human picker calls, run for
 * this run's own tenant/principal via `GET /targets`. Throws a plain
 * `Error` on any transport, HTTP, or shape failure; never fabricates a
 * list. */
export async function listTargets(
  config: RoutineToolClientConfig,
): Promise<readonly RoutineTargetView[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/targets"), {
    headers: authHeaders(config),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Listing routine targets failed: ${response.status} ${response.statusText}`,
      ),
    );
  }
  const body: unknown = await response.json();
  const parsed = RoutineTargetsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Routine targets response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.items;
}
