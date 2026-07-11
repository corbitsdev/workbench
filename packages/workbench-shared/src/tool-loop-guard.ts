import { createHash } from "node:crypto";

// Generalization of the search_tools loop guard: a model repeating the exact
// same failing tool call (same name + same serialized args) is not converging
// and must be pushed off the loop. The escalation keys on CONSECUTIVE
// identical failures — a success or any different call resets the run — so a
// long-lived session never accumulates toward a stop on ordinary use.
//
// Trade-off: the guard cannot tell a transient failure (network blip, rate
// limit) from a deterministic one (validation error), so a genuinely
// transient error retried verbatim can reach the block. That is acceptable
// because the reset rules make the block self-healing: any different call or
// any success clears it, and a model told to change its approach will do one
// of those. Client aborts are the one error class excluded outright — they
// say nothing about the call itself.
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
   * message from the 3rd. A client abort (AbortError) is not a failure of the
   * call and leaves the run untouched.
   */
  recordFailure(
    sessionId: string,
    toolName: string,
    args: unknown,
    error?: unknown,
  ): string | undefined;
  /** Any successful call resets the session's run. */
  recordSuccess(sessionId: string): void;
};

type RunState = {
  lastKey: string;
  consecutiveFailures: number;
};

// Duck-typed on `name`: an abort may surface as Error or DOMException
// depending on the runtime and the throwing layer.
function isClientAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

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

// Digest rather than the raw serialized args: lastKey is retained per session
// for the lifetime of the LRU entry, and tool args can be large.
function callKey(toolName: string, args: unknown): string {
  return createHash("sha256")
    .update(`${toolName}\u0000${stableStringify(args)}`)
    .digest("hex");
}

function blockedMessage(toolName: string): string {
  return `This exact ${toolName} call has failed repeatedly with identical arguments and is blocked. Do not retry it with the same arguments — change your approach or report the problem to the user.`;
}

function escalation(toolName: string, count: number): string | undefined {
  if (count >= TOOL_LOOP_BLOCK_THRESHOLD) {
    return blockedMessage(toolName);
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
        // Refresh recency: an actively-blocked session must not be evicted
        // (and thereby unblocked) by churn from other sessions.
        touch(sessionId, state);
        return blockedMessage(toolName);
      }
      return undefined;
    },
    recordFailure(sessionId, toolName, args, error) {
      if (isClientAbort(error)) return undefined;
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
