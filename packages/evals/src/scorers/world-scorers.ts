// Pure `Scorer` factories over `ctx.world` (see ../types.ts) — the
// same `{name, score, pass, reason}` contract `scorers.ts` uses for
// transcript-based checks, applied instead to what the tenant's own
// tables actually hold. No network, no clock; unit-testable against a
// hand-built `WorldSnapshot` (see world-scorers.test.ts).
import type { FakeReceipt, ScorerContext, ScorerResult } from "../types.ts";

function result(
  name: string,
  pass: boolean,
  reason: string,
  score = pass ? 1 : 0,
): ScorerResult {
  return { name, pass, reason, score };
}

/** Passes once an agent definition named `agentName` exists and has
 * every one of `tools` among its pinned tool packages. */
export function agentHasTools(agentName: string, tools: readonly string[]) {
  return function agentHasToolsScorer(ctx: ScorerContext): ScorerResult {
    const agent = ctx.world.agentDefinitions.find(
      (definition) => definition.name === agentName,
    );
    if (agent === undefined) {
      return result(
        "agentHasTools",
        false,
        `no agent definition named "${agentName}" exists yet`,
      );
    }
    const missing = tools.filter(
      (tool) => !agent.toolPackagePins.includes(tool),
    );
    return result(
      "agentHasTools",
      missing.length === 0,
      missing.length === 0
        ? `"${agentName}" has all of: ${tools.join(", ")}`
        : `"${agentName}" is missing: ${missing.join(", ")}`,
    );
  };
}

/** Passes once a routine named `routineName` exists whose trigger
 * carries `kind === trigger`. */
export function routineHasTrigger(routineName: string, trigger: string) {
  return function routineHasTriggerScorer(ctx: ScorerContext): ScorerResult {
    const routine = ctx.world.routines.find((r) => r.name === routineName);
    if (routine === undefined) {
      return result(
        "routineHasTrigger",
        false,
        `no routine named "${routineName}" exists yet`,
      );
    }
    const kind =
      typeof routine.trigger === "object" &&
      routine.trigger !== null &&
      "kind" in routine.trigger
        ? (routine.trigger as Record<string, unknown>)["kind"]
        : undefined;
    return result(
      "routineHasTrigger",
      kind === trigger,
      kind === trigger
        ? `"${routineName}" has trigger.kind="${trigger}"`
        : `"${routineName}" has trigger.kind=${JSON.stringify(kind)}, expected "${trigger}"`,
    );
  };
}

/** Passes once a routine named `routineName` exists and delivers to
 * `workbenchId`. */
export function routineDeliversTo(routineName: string, workbenchId: string) {
  return function routineDeliversToScorer(ctx: ScorerContext): ScorerResult {
    const routine = ctx.world.routines.find((r) => r.name === routineName);
    if (routine === undefined) {
      return result(
        "routineDeliversTo",
        false,
        `no routine named "${routineName}" exists yet`,
      );
    }
    return result(
      "routineDeliversTo",
      routine.deliveryWorkbenchId === workbenchId,
      routine.deliveryWorkbenchId === workbenchId
        ? `"${routineName}" delivers to ${workbenchId}`
        : `"${routineName}" delivers to ${JSON.stringify(routine.deliveryWorkbenchId)}, expected ${workbenchId}`,
    );
  };
}

/** Passes once a connection with the given `slug` is live (its
 * credential is active). */
export function connectionIsLive(slug: string) {
  return function connectionIsLiveScorer(ctx: ScorerContext): ScorerResult {
    const connection = ctx.world.connections.find((c) => c.slug === slug);
    if (connection === undefined) {
      return result("connectionIsLive", false, `no connection "${slug}" found`);
    }
    return result(
      "connectionIsLive",
      connection.live,
      connection.live
        ? `"${slug}" is live`
        : `"${slug}" is connected but not live`,
    );
  };
}

/** Passes once the recording fake for `server` received a call to
 * `toolName` whose arguments satisfy `matcher` (default: any
 * arguments). */
export function fakeReceived(
  server: string,
  toolName: string,
  matcher?: (args: Record<string, unknown>) => boolean,
) {
  return function fakeReceivedScorer(ctx: ScorerContext): ScorerResult {
    const matches = ctx.world.fakeReceipts.filter(
      (receipt: FakeReceipt) =>
        receipt.server === server &&
        receipt.toolName === toolName &&
        (matcher === undefined || matcher(receipt.arguments)),
    );
    return result(
      "fakeReceived",
      matches.length > 0,
      matches.length > 0
        ? `${server}.${toolName} received ${String(matches.length)} matching call(s)`
        : `${server}.${toolName} received no matching call`,
    );
  };
}
