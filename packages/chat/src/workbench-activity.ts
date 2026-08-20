// The read-cursor math behind a workbench row's activity signals, kept
// apart from `platform-adapter.ts`'s drizzle plumbing so it is
// testable without a database. `createHubChatPlatform`'s
// `listWorkbenchActivity` runs two bulk SQL aggregates — the newest
// message per session, and the count of messages per session newer
// than that workbench's own read cursor — and hands both, plus the
// workbenchId -> sessionId map it resolved to run them, to
// `summarizeWorkbenchActivity` below to fold back into one record per
// workbenchId.
import type { WorkbenchActivitySummary } from "./platform-port";

/** A workbench counts as "live" when its newest message landed within
 * this window of now — no fake presence, just recency. */
export const LIVE_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export function isRecentlyActive(
  lastActivityAt: string,
  now: Date = new Date(),
): boolean {
  return now.getTime() - Date.parse(lastActivityAt) <= LIVE_ACTIVITY_WINDOW_MS;
}

export interface SessionActivityAggregate {
  readonly sessionId: string;
  readonly lastActivityAt: string;
  /** The newest message's bounded text preview, when one could be
   * extracted (see `extractTextPreview`) — absent for an attachment-only
   * message, never a fabricated placeholder. */
  readonly preview?: string;
}

export interface SessionUnreadAggregate {
  readonly sessionId: string;
  readonly unreadCount: number;
}

/**
 * Folds two grouped SQL aggregates back onto `workbenchId` via the
 * workbenchId -> sessionId map `listWorkbenchActivity` resolved in bulk.
 * A workbench absent from that map (its session could not be resolved —
 * a launch that never completed, say) is absent from the result too:
 * "render only when present" applies to the wire just as much as the
 * row, so this never fabricates a zero for a workbench whose real count
 * is unknown. A workbench present in the map but with no aggregate row
 * (no messages at all yet) gets `unreadCount: 0` and no
 * `lastActivityAt` — a real, honest "nothing has happened here yet."
 */
export function summarizeWorkbenchActivity(
  workbenchSessionIds: ReadonlyMap<string, string>,
  latestBySession: readonly SessionActivityAggregate[],
  unreadBySession: readonly SessionUnreadAggregate[],
): Record<string, WorkbenchActivitySummary> {
  const latestBySessionId = new Map(
    latestBySession.map((row) => [row.sessionId, row]),
  );
  const unreadBySessionId = new Map(
    unreadBySession.map((row) => [row.sessionId, row.unreadCount]),
  );

  const result: Record<string, WorkbenchActivitySummary> = {};
  for (const [workbenchId, sessionId] of workbenchSessionIds) {
    const latest = latestBySessionId.get(sessionId);
    const unreadCount = unreadBySessionId.get(sessionId) ?? 0;
    if (latest === undefined) {
      result[workbenchId] = { unreadCount };
      continue;
    }
    result[workbenchId] =
      latest.preview === undefined || latest.preview.length === 0
        ? { unreadCount, lastActivityAt: latest.lastActivityAt }
        : {
            unreadCount,
            lastActivityAt: latest.lastActivityAt,
            preview: latest.preview,
          };
  }
  return result;
}
