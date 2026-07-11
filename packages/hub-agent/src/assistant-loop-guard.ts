// WORKBENCH-LOCAL (CL-3340): assistant output loop guard. Detects an agent
// stuck emitting the same visible response over and over within one session
// so the SessionManager can interrupt the turn instead of letting the
// reactor burn inference forever. Identity is a normalized (trimmed,
// whitespace-collapsed) exact match of consecutive non-empty assistant
// texts; any different output or a user message resets the run, so long
// healthy sessions never accumulate toward a stop.

export const ASSISTANT_LOOP_THRESHOLD = 3;

const DEFAULT_MAX_SESSIONS = 1000;

export function normalizeAssistantOutput(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function assistantLoopInterruptMessage(count: number): string {
  return `The assistant produced the same response ${String(count)} times in a row, so the turn was stopped to break the loop. The conversation is still usable — send a new message to continue.`;
}

/**
 * Extracts the user-visible text of an assistant turn: the text blocks of
 * `inference.done`'s `turn.content`, joined. Non-text blocks (thinking,
 * tool calls, images) carry no visible response and are ignored.
 */
export function extractAssistantText(
  content: readonly { type: string; text?: string }[],
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export type AssistantLoopGuard = {
  /**
   * Records one assistant output for the session. Returns the interrupt
   * explanation once the same normalized output has been seen `threshold`
   * times in a row; empty (whitespace-only) outputs are ignored — a
   * tool-only inference cycle is not an assistant message. Tripping clears
   * the run so a resumed session starts fresh.
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
