// WORKBENCH-LOCAL (CL-3340): assistant output loop guard. Detects an agent
// stuck emitting the same output over and over so the SessionManager can
// interrupt the turn instead of letting the reactor burn inference forever.
// The practical trip path is tool-executing cycles WITHIN one message run:
// every inbound user message resets the run, so cross-turn repetition never
// trips — what trips is a reactor cycling inside a single turn. Because of
// that, tool-call identity is part of the duplicate fingerprint: identical
// narration with DIFFERENT tool calls is progress, not a loop. A cycle's
// fingerprint is its normalized (trimmed, whitespace-collapsed) text plus
// its tool calls (name + stable-serialized arguments; the per-call id is
// excluded). Any different fingerprint or a user message resets the run.

export const ASSISTANT_LOOP_THRESHOLD = 3;

const DEFAULT_MAX_SESSIONS = 1000;

export function normalizeAssistantOutput(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function assistantLoopInterruptMessage(count: number): string {
  return `The assistant produced the same response ${String(count)} times in a row, so the turn was stopped to break the loop. The conversation is still usable — send a new message to continue.`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

type CycleBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

/**
 * Fingerprints one inference cycle from `inference.done`'s `turn.content`:
 * the normalized text blocks plus each tool call's identity (name +
 * stable-serialized arguments — argument key order and the reactor-minted
 * call id do not affect identity). Thinking and other non-visible,
 * non-acting blocks are ignored. An empty fingerprint means the cycle
 * neither said nor did anything comparable and is skipped by the guard.
 */
export function assistantCycleFingerprint(
  content: readonly CycleBlock[],
): string {
  const text = normalizeAssistantOutput(
    content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n"),
  );
  const toolCalls = content
    .filter((block) => block.type === "tool_call")
    .map(
      (block) =>
        `${block.name ?? ""}(${stableStringify(block.arguments ?? {})})`,
    )
    .join(" ");
  if (text === "" && toolCalls === "") return "";
  return `${text} ${toolCalls}`;
}

export type AssistantLoopGuard = {
  /**
   * Records one assistant cycle fingerprint (or raw output text) for the
   * session. Returns the interrupt explanation once the same normalized
   * value has been seen `threshold` times in a row; empty (whitespace-only)
   * values are ignored — a cycle that neither said nor did anything has no
   * identity to compare. Tripping clears the run so a resumed session
   * starts fresh.
   */
  recordAssistantOutput(sessionKey: string, text: string): string | undefined;
  /** Clears the session's run (user message arrived / session rebuilt). */
  reset(sessionKey: string): void;
};

export type AssistantLoopGuardOpts = {
  threshold?: number;
  maxSessions?: number;
};

type RunState = {
  lastOutput: string;
  consecutive: number;
};

export function createAssistantLoopGuard(
  opts: AssistantLoopGuardOpts = {},
): AssistantLoopGuard {
  const threshold = opts.threshold ?? ASSISTANT_LOOP_THRESHOLD;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, RunState>();

  function touch(sessionKey: string, state: RunState): void {
    sessions.delete(sessionKey);
    sessions.set(sessionKey, state);
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  }

  return {
    recordAssistantOutput(sessionKey, text) {
      const normalized = normalizeAssistantOutput(text);
      if (normalized === "") return undefined;
      const state = sessions.get(sessionKey);
      const consecutive =
        state !== undefined && state.lastOutput === normalized
          ? state.consecutive + 1
          : 1;
      if (consecutive >= threshold) {
        sessions.delete(sessionKey);
        return assistantLoopInterruptMessage(consecutive);
      }
      touch(sessionKey, { lastOutput: normalized, consecutive });
      return undefined;
    },
    reset(sessionKey) {
      sessions.delete(sessionKey);
    },
  };
}
