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
 * Whether a system prompt carries a seed marker at all. Lets the harness tell a
 * present-but-empty (malformed) marker apart from no marker: the former is a
 * contract break worth a warning, the latter is a normal non-seeding agent.
 */
export function hasSeedMarker(systemPrompt: string): boolean {
  return SEED_MARKER_PATTERN.test(systemPrompt);
}

/**
 * Result of parsing a seed marker: the resolvable {path, content}[] to seed and
 * the declared basenames that could not be resolved (unknown to the table, or
 * unsafe non-basenames). Skips are surfaced, never thrown — a since-folded seed
 * file named in an OLD persisted prompt must not wedge a live session on sidecar
 * restore (CL-2364). The build-time drift test guards against the table and the
 * live prompt's marker diverging, so genuine drift fails in CI, not in prod.
 */
export interface SeedMarkerParse {
  files: SeedWorkspaceFile[];
  skipped: string[];
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
  if (!match || match[1] === undefined) return { files: [], skipped: [] };

  const declared = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const files: SeedWorkspaceFile[] = [];
  const skipped: string[] = [];
  for (const name of declared) {
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
  return { files, skipped };
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
