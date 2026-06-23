/**
 * A workspace file the agent expects to exist before its first turn. The
 * harness writes `content` to `path` (relative to the agent workspace) only
 * when no file already exists there — accumulated memory is never overwritten.
 */
export interface SeedWorkspaceFile {
  path: string;
  content: string;
}

function stubFor(title: string, description: string): string {
  return `# ${title}\n\n${description}\n`;
}

/**
 * Myra's documented memory files (see the personal-agent prompt `<notes>`
 * section). On first launch none of these exist, so reading them fails; the
 * harness seeds these stubs so the agent always has them to read and append to.
 */
export const PERSONAL_AGENT_SEED_FILES: SeedWorkspaceFile[] = [
  {
    path: 'MEMORY.md',
    content: stubFor('Memory', 'Durable facts worth keeping across tasks.'),
  },
  {
    path: 'SCRATCHPAD.md',
    content: stubFor('Scratchpad', 'Transient notes for the current task.'),
  },
  {
    path: 'CONTACTS.md',
    content: stubFor(
      'Contacts',
      'Agents and people: who they are, what they are for, their addresses.'
    ),
  },
  {
    path: 'ERRORS.md',
    content: stubFor('Errors', 'Failures hit, with enough detail to avoid them next time.'),
  },
  {
    path: 'HUMAN.md',
    content: stubFor(
      'Human',
      'Standing brief on the person you work for: preferences, priorities, open tasks and todos.'
    ),
  },
];

const SEED_MARKER_PREFIX = '<!-- workbench:memory-seed=';
const SEED_MARKER_SUFFIX = ' -->';
const SEED_MARKER_PATTERN = /<!--\s*workbench:memory-seed=([^>]*?)\s*-->/;
const SEED_MARKER_PATTERN_GLOBAL = /<!--\s*workbench:memory-seed=([^>]*?)\s*-->/g;

/**
 * A seed-file name is always a plain basename. Anything with a path separator or
 * `..` segment is rejected so a crafted marker cannot direct the harness to
 * write outside the workspace (defence in depth alongside the harness-side
 * containment check) — CL-1952.
 */
function assertPlainBasename(name: string): void {
  if (name.includes('/') || name.includes('\\') || name === '..' || name.includes('..')) {
    throw new Error(`Seed marker entry "${name}" is not a plain basename`);
  }
}

/**
 * Machine-readable sentinel listing the files to seed, emitted into the BASE
 * personal-agent prompt. The hub personalizes the prompt by APPENDING an
 * <operator> section before launch, so a marker embedded in the base content
 * survives into the effective launched prompt — unlike exact-equality matching
 * the whole prompt, which the appended section defeats (CL-1952).
 */
export function buildSeedMarker(files: SeedWorkspaceFile[]): string {
  const names = files.map((f) => f.path).join(',');
  return `${SEED_MARKER_PREFIX}${names}${SEED_MARKER_SUFFIX}`;
}

const seedFileByPath = new Map(PERSONAL_AGENT_SEED_FILES.map((file) => [file.path, file]));

/**
 * Whether a system prompt carries a seed marker at all. Lets the harness tell a
 * present-but-empty (malformed) marker apart from no marker: the former is a
 * contract break worth a warning, the latter is a normal non-seeding agent.
 */
export function hasSeedMarker(systemPrompt: string): boolean {
  return SEED_MARKER_PATTERN.test(systemPrompt);
}

/**
 * Parse the seed marker out of an effective system prompt and return the full
 * {path, content}[] to seed. The marker carries only filenames; stub content is
 * resolved here from the package-owned `PERSONAL_AGENT_SEED_FILES`, so the
 * harness stays generic and never hardcodes Myra's filenames. A prompt with no
 * marker (any non-personal agent) yields an empty list.
 *
 * A marker naming a file with no known stub is a contract break between the
 * prompt builder and this table — fail loudly rather than silently seed less.
 */
export function parseSeedMarker(systemPrompt: string): SeedWorkspaceFile[] {
  const match = SEED_MARKER_PATTERN.exec(systemPrompt);
  if (!match || match[1] === undefined) return [];

  const declared = match[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return declared.map((name) => {
    assertPlainBasename(name);
    const file = seedFileByPath.get(name);
    if (!file) {
      throw new Error(`Seed marker declares "${name}" but no stub content is registered for it`);
    }
    return file;
  });
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
    .replace(SEED_MARKER_PATTERN_GLOBAL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
