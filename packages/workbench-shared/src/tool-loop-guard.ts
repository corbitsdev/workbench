// Generalization of the search_tools loop guard: a model repeating the exact
// same failing tool call (same name + same serialized args) is not converging
// and must be pushed off the loop. The escalation keys on CONSECUTIVE
// identical failures — a success or any different call resets the run — so a
// long-lived session never accumulates toward a stop on ordinary use.
export const TOOL_LOOP_HINT_THRESHOLD = 2;
export const TOOL_LOOP_BLOCK_THRESHOLD = 3;

const DEFAULT_MAX_SESSIONS = 1000;

export type ToolLoopGuard = {
  /**
   * Pre-execution gate: returns a refusal message when this exact call has
   * already hit the block ceiling, so a blocked call never executes again.
   */
  checkBlocked(
    sessionId: string,
    toolName: string,
    args: unknown,
  ): string | undefined;
  /**
   * Record a failed call. Returns an escalation to append to the tool error:
   * a corrective hint from the 2nd consecutive identical failure, a hard-stop
   * message from the 3rd.
   */
  recordFailure(
    sessionId: string,
    toolName: string,
    args: unknown,
  ): string | undefined;
  /** Any successful call resets the session's run. */
  recordSuccess(sessionId: string): void;
};

type RunState = {
  lastKey: string;
  consecutiveFailures: number;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function callKey(toolName: string, args: unknown): string {
  return `${toolName}\u0000${stableStringify(args)}`;
}

function escalation(toolName: string, count: number): string | undefined {
  if (count >= TOOL_LOOP_BLOCK_THRESHOLD) {
    return `This exact ${toolName} call has failed ${count} times in a row and is now blocked. Do not retry it with the same arguments — change your approach or report the problem to the user.`;
  }
  if (count >= TOOL_LOOP_HINT_THRESHOLD) {
    return `You have made this exact ${toolName} call ${count} times in a row and it failed each time. Change the arguments to fix the error above, or stop calling this tool and report the failure to the user.`;
  }
  return undefined;
}

export function createToolLoopGuard(opts?: {
  maxSessions?: number;
}): ToolLoopGuard {
  const maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, RunState>();

  function touch(sessionId: string, state: RunState): void {
    sessions.delete(sessionId);
    sessions.set(sessionId, state);
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  }

  return {
    checkBlocked(sessionId, toolName, args) {
      const state = sessions.get(sessionId);
      if (
        state !== undefined &&
        state.lastKey === callKey(toolName, args) &&
        state.consecutiveFailures >= TOOL_LOOP_BLOCK_THRESHOLD
      ) {
        return `This exact ${toolName} call has failed ${state.consecutiveFailures} times in a row and is blocked. Do not retry it with the same arguments — change your approach or report the problem to the user.`;
      }
      return undefined;
    },
    recordFailure(sessionId, toolName, args) {
      const key = callKey(toolName, args);
      const state = sessions.get(sessionId);
      const consecutiveFailures =
        state !== undefined && state.lastKey === key
          ? state.consecutiveFailures + 1
          : 1;
      touch(sessionId, { lastKey: key, consecutiveFailures });
      return escalation(toolName, consecutiveFailures);
    },
    recordSuccess(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
