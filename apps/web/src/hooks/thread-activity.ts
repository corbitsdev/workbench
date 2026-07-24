// Per-browser watermark of when each Myra thread was last viewed, so the
// thread lists can show a "new activity" indicator when a reply lands while
// the member is away (CL-4257: waiting is optional — leaving a thread must
// not hide that something arrived). Purely a client-side signal: the hub does
// not track per-viewer read state, so this is scoped to the current browser,
// same as `readLastActiveThreadId`/`writeLastActiveThreadId` in
// use-myra-threads.ts.
const LAST_VIEWED_KEY = "myra-thread-last-viewed";

type LastViewedMap = Record<string, string>;

function readMap(): LastViewedMap {
  try {
    const raw = localStorage.getItem(LAST_VIEWED_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as LastViewedMap;
  } catch {
    return {};
  }
}

function writeMap(map: LastViewedMap): void {
  try {
    localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (private browsing, quota) — the indicator
    // degrades to always-read rather than throwing.
  }
}

export function readThreadLastViewedAt(threadId: string): string | null {
  return readMap()[threadId] ?? null;
}

/** Record that this browser viewed `threadId` as of `at` (its own
 * `lastActivityAt`, not wall-clock time, so a stale watermark from a slow
 * effect can never mask activity that happened after the view). */
export function markThreadViewed(threadId: string, at: string): void {
  const map = readMap();
  if (map[threadId] === at) return;
  map[threadId] = at;
  writeMap(map);
}

/**
 * Whether `thread` has activity the member has not seen in this browser. A
 * thread that has never been viewed here is not flagged — it is simply
 * unopened, and the thread list itself is the discovery surface for that,
 * not this indicator.
 */
export function threadHasNewActivity(thread: {
  id: string;
  lastActivityAt: string;
}): boolean {
  const lastViewed = readThreadLastViewedAt(thread.id);
  if (lastViewed === null) return false;
  return (
    new Date(thread.lastActivityAt).getTime() > new Date(lastViewed).getTime()
  );
}
