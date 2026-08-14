// The read-cursor math behind a channel row's activity signals, kept
// apart from `platform-adapter.ts`'s drizzle plumbing so it is
// testable without a database. `createHubChatPlatform`'s
// `listChannelActivity` runs two bulk SQL aggregates — the newest
// message per session, and the count of messages per session newer
// than that channel's own read cursor — and hands both, plus the
// channelId -> sessionId map it resolved to run them, to
// `summarizeChannelActivity` below to fold back into one record per
// channelId.
import type { ChannelActivitySummary } from "./platform-port";

/** A channel counts as "live" when its newest message landed within
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
}

export interface SessionUnreadAggregate {
  readonly sessionId: string;
  readonly unreadCount: number;
}

/**
 * Folds two grouped SQL aggregates back onto `channelId` via the
 * channelId -> sessionId map `listChannelActivity` resolved in bulk.
 * A channel absent from that map (its session could not be resolved —
 * a launch that never completed, say) is absent from the result too:
 * "render only when present" applies to the wire just as much as the
 * row, so this never fabricates a zero for a channel whose real count
 * is unknown. A channel present in the map but with no aggregate row
 * (no messages at all yet) gets `unreadCount: 0` and no
 * `lastActivityAt` — a real, honest "nothing has happened here yet."
 */
export function summarizeChannelActivity(
  channelSessionIds: ReadonlyMap<string, string>,
  latestBySession: readonly SessionActivityAggregate[],
  unreadBySession: readonly SessionUnreadAggregate[],
): Record<string, ChannelActivitySummary> {
  const latestBySessionId = new Map(
    latestBySession.map((row) => [row.sessionId, row.lastActivityAt]),
  );
  const unreadBySessionId = new Map(
    unreadBySession.map((row) => [row.sessionId, row.unreadCount]),
  );

  const result: Record<string, ChannelActivitySummary> = {};
  for (const [channelId, sessionId] of channelSessionIds) {
    const lastActivityAt = latestBySessionId.get(sessionId);
    const unreadCount = unreadBySessionId.get(sessionId) ?? 0;
    result[channelId] =
      lastActivityAt === undefined
        ? { unreadCount }
        : { unreadCount, lastActivityAt };
  }
  return result;
}
