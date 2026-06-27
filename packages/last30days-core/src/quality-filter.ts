import type { ResearchItem, SourceLabel } from "./schema";

// Sources where engagement (votes, comments, views) IS the signal — a post here
// with zero engagement and no discussion is noise, not evidence. Web/HN/GitHub
// are excluded: a low-engagement web article or a quiet repo can still be
// substantive, so they are never dropped on the zero-signal rule.
const ENGAGEMENT_SOURCES = new Set<SourceLabel>([
  "x",
  "reddit",
  "tiktok",
  "instagram",
  "threads",
  "pinterest",
  "bluesky",
]);

// A bare social handle with no real content: "@jack", "someuser" — a single
// token, optionally @-prefixed, no whitespace, nothing to read. Distinct from a
// real post that merely mentions a handle (those carry surrounding words).
const BARE_HANDLE = /^@?[a-z0-9_.]{1,30}$/i;

// A clone / white-label boilerplate repo: "miracuves/neobank-clone",
// "*/revolut-clone", and the "white-label, launch in N days" template spam. The
// repo-slug "-clone" suffix is the strong tell; the phrase set catches the rest.
const CLONE_SLUG = /[-/][a-z0-9]+-clone\b/i;
const CLONE_PHRASES =
  /white[-\s]?label|launch in \d+\s*days?|saas\s+clone|clone\s+script|ready[-\s]?made\s+(app|clone)/i;

function engagementTotal(item: ResearchItem): number {
  const e = item.engagement;
  if (e === undefined) return 0;
  // Stars are deliberately excluded — a repo's star count is not an engagement
  // vote (mirrors rank-score's engagementScore).
  return (
    (e.upvotes ?? 0) + (e.comments ?? 0) + (e.views ?? 0) + (e.shares ?? 0)
  );
}

function hasComments(item: ResearchItem): boolean {
  return item.topComments !== undefined && item.topComments.length > 0;
}

function isBareHandle(item: ResearchItem): boolean {
  if (!ENGAGEMENT_SOURCES.has(item.source)) return false;
  const title = item.title.trim();
  // A real post has spaces and substance; a bare handle is one contentless token.
  if (title.includes(" ")) return false;
  return BARE_HANDLE.test(title);
}

function isCloneRepo(item: ResearchItem): boolean {
  if (item.source !== "github") return false;
  const haystack = `${item.url} ${item.title}`;
  if (CLONE_SLUG.test(haystack)) return true;
  return /clone/i.test(haystack) && CLONE_PHRASES.test(haystack);
}

// A zero-signal item on an engagement source: nothing engaged with it AND no
// discussion to read. Substantive-but-quiet articles live on web/HN/GitHub, so
// they never reach this rule.
function isZeroSignal(item: ResearchItem): boolean {
  if (!ENGAGEMENT_SOURCES.has(item.source)) return false;
  return engagementTotal(item) === 0 && !hasComments(item);
}

// A repo search on a consumer/product/launch topic floods the pool with 0-1 star
// pet projects, clones, tutorial outputs, and portfolio pieces that merely carry
// the topic word — exactly the GitHub junk Larry's methodology drops ("keep a repo
// only if there is genuine recent activity"). A star count is the cheapest
// traction proxy: a repo below the floor (or with no stars at all) is not a launch
// signal. The floor is low so a genuinely notable new project clears it.
const GITHUB_TRACTION_FLOOR = 10;
function isLowTractionRepo(item: ResearchItem): boolean {
  if (item.source !== "github") return false;
  const stars = item.engagement?.stars ?? 0;
  return stars < GITHUB_TRACTION_FLOOR;
}

/**
 * Drop low-value junk before items reach clustering and the brief: bare social
 * handles with no content, clone/white-label/boilerplate repos, and zero-signal
 * social posts (no engagement, no discussion). Conservative by construction — it
 * never touches web/HN/GitHub articles on the zero-signal rule, so a legitimate
 * low-engagement article survives. Mirrors the reference engine's intent
 * (entity-grounding + engagement floors) with explicit drops for the junk
 * patterns the deterministic ranker alone let through.
 */
export function isJunkItem(item: ResearchItem): boolean {
  return (
    isBareHandle(item) ||
    isCloneRepo(item) ||
    isLowTractionRepo(item) ||
    isZeroSignal(item)
  );
}

export function qualityFilter(items: ResearchItem[]): ResearchItem[] {
  return items.filter((item) => !isJunkItem(item));
}
