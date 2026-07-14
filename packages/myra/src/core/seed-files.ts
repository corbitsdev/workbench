/**
 * A workspace file the agent expects to exist before its first turn. The
 * harness writes `content` to `path` (relative to the agent workspace) only
 * when no file already exists there — accumulated memory is never overwritten.
 */
export interface SeedWorkspaceFile {
  path: string;
  content: string;
}

/**
 * Files the harness seeds into Myra's workspace before her first turn.
 *
 * Empty by design: Myra's durable memory moved off the filesystem to the
 * hub-owned, versioned artifact store, accessed via the `memory_load` /
 * `memory_save` tools (CL-2413). A sidecar-local MEMORY.md was lost on every
 * wipe/redeploy, so there is no seed file to write. The marker/parser machinery
 * below stays — it is generic harness infrastructure and an old persisted
 * prompt may still carry a `MEMORY.md` marker, which `parseSeedMarker` now
 * resolves to nothing (gracefully skipped, never wedging restore — CL-2364).
 */
export const PERSONAL_AGENT_SEED_FILES: SeedWorkspaceFile[] = [];

const SEED_MARKER_PREFIX = "<!-- workbench:memory-seed=";
const SEED_MARKER_SUFFIX = " -->";
const SEED_MARKER_PATTERN = /<!--\s*workbench:memory-seed=([^>]*?)\s*-->/;
const SEED_MARKER_PATTERN_GLOBAL =
  /<!--\s*workbench:memory-seed=([^>]*?)\s*-->/g;

/**
 * A seed-file name is always a plain basename. Anything with a path separator or
 * `..` segment is unsafe: a crafted marker could direct the harness to write
 * outside the workspace (defence in depth alongside the harness-side containment
 * check) — CL-1952.
 */
function isPlainBasename(name: string): boolean {
  return !(
    name.includes("/") ||
    name.includes("\\") ||
    name === ".." ||
    name.includes("..")
  );
}

/**
 * Machine-readable sentinel listing the files to seed, emitted into the BASE
 * personal-agent prompt. The hub personalizes the prompt by APPENDING an
 * <operator> section before launch, so a marker embedded in the base content
 * survives into the effective launched prompt — unlike exact-equality matching
 * the whole prompt, which the appended section defeats (CL-1952).
 */
export function buildSeedMarker(files: SeedWorkspaceFile[]): string {
  const names = files.map((f) => f.path).join(",");
  return `${SEED_MARKER_PREFIX}${names}${SEED_MARKER_SUFFIX}`;
}

const seedFileByPath = new Map(
  PERSONAL_AGENT_SEED_FILES.map((file) => [file.path, file]),
);

/**
 * Seed files that were once registered but have since been deliberately folded
 * away — their content moved off the filesystem (e.g. MEMORY.md → the hub
 * artifact store, CL-2413). An OLD persisted prompt still names them in its
 * marker, so on every sidecar restore the parser would otherwise classify them
 * as unexpected unresolvable files and the harness would log a warning per
 * instance per boot. They are a KNOWN, intentional fold — resolving them to
 * nothing is correct and silent, not a contract break (CL-2364). A genuinely
 * unknown or unsafe name still lands in `skipped` and is surfaced.
 *
 * Sunset: this set exists only to silence markers in OLD persisted prompts. The
 * current prompt builder emits no marker, so every redeploy overwrites a prompt
 * with a marker-free one. Once all live instances have redeployed past CL-2413,
 * no reachable prompt can name a retired file and this set is dead — remove it
 * then (tracked as a follow-up). A name must never be in BOTH this set and
 * `PERSONAL_AGENT_SEED_FILES`, or it would be silently dropped instead of
 * seeded; the seed-files test asserts that disjointness.
 */
export const RETIRED_SEED_FILES = new Set(["MEMORY.md"]);

/**
 * Whether a system prompt carries a seed marker at all. Lets the harness tell a
 * present-but-empty (malformed) marker apart from no marker: the former is a
 * contract break worth a warning, the latter is a normal non-seeding agent.
 */
export function hasSeedMarker(systemPrompt: string): boolean {
  return SEED_MARKER_PATTERN.test(systemPrompt);
}

/**
 * Result of parsing a seed marker:
 *   - `files`   — resolvable {path, content}[] to seed
 *   - `retired` — declared names that name a KNOWN, deliberately-folded seed
 *     file (`RETIRED_SEED_FILES`); resolving them to nothing is expected, so the
 *     harness drops them silently rather than warning per instance per boot
 *   - `skipped` — declared basenames that are genuinely unexpected (unknown to
 *     the table, or unsafe non-basenames); surfaced via a warning
 *
 * Nothing is ever thrown — a since-folded seed file named in an OLD persisted
 * prompt must not wedge a live session on sidecar restore (CL-2364). The
 * build-time drift test guards against the table and the live prompt's marker
 * diverging, so genuine drift fails in CI, not in prod.
 */
export interface SeedMarkerParse {
  files: SeedWorkspaceFile[];
  skipped: string[];
  retired: string[];
}

/**
 * Parse the seed marker out of an effective system prompt. The marker carries
 * only filenames; stub content is resolved here from the package-owned
 * `PERSONAL_AGENT_SEED_FILES`, so the harness stays generic and never hardcodes
 * Myra's filenames. A prompt with no marker (any non-personal agent) yields an
 * empty result.
 *
 * A declared basename with no known stub — or an unsafe non-basename — is
 * SKIPPED and collected in `skipped` rather than thrown, so restoring from an
 * old persisted prompt that still lists a since-folded file cannot abort the
 * harness build (CL-2364).
 */
export function parseSeedMarker(systemPrompt: string): SeedMarkerParse {
  const match = SEED_MARKER_PATTERN.exec(systemPrompt);
  if (!match || match[1] === undefined)
    return { files: [], skipped: [], retired: [] };

  const declared = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const files: SeedWorkspaceFile[] = [];
  const skipped: string[] = [];
  const retired: string[] = [];
  for (const name of declared) {
    if (RETIRED_SEED_FILES.has(name)) {
      retired.push(name);
      continue;
    }
    if (!isPlainBasename(name)) {
      skipped.push(name);
      continue;
    }
    const file = seedFileByPath.get(name);
    if (file) {
      files.push(file);
      continue;
    }
    skipped.push(name);
  }
  return { files, skipped, retired };
}

/**
 * A parsed marker plus the one derived decision the harness acts on: whether the
 * marker is `malformed` — present but resolving to NOTHING (no seeded file, no
 * skipped name, no retired name). That is the only case worth a per-boot
 * warning: a marker naming only since-retired files (an old MEMORY.md prompt) is
 * expected and stays silent (CL-2509), while unresolvable names are surfaced via
 * `skipped`. Owning this decision here keeps the harness a thin caller and makes
 * the gating directly testable.
 */
export interface SeedMarkerResolution extends SeedMarkerParse {
  malformed: boolean;
}

export function resolveSeedMarker(systemPrompt: string): SeedMarkerResolution {
  const parse = parseSeedMarker(systemPrompt);
  const malformed =
    hasSeedMarker(systemPrompt) &&
    parse.files.length === 0 &&
    parse.skipped.length === 0 &&
    parse.retired.length === 0;
  return { ...parse, malformed };
}

/**
 * Remove the seed marker from a system prompt. The marker is a control-plane
 * sentinel for the harness; the live model must never see it (it would surface
 * as raw text the agent could echo or be confused by). The harness parses the
 * file list off the raw base prompt, then strips the marker before the prompt
 * reaches the model (CL-1952). Surrounding blank lines left by the removed
 * trailing line are collapsed so the cleaned prompt has no dangling whitespace.
 */
export function stripSeedMarker(systemPrompt: string): string {
  return systemPrompt
    .replace(SEED_MARKER_PATTERN_GLOBAL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
