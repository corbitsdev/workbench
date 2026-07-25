export const DOCKERFILE_TOOL_MANIFEST_EXTRA_DIRS = [
  "packages/tool-manifest",
  "packages/tools-catalog",
  "packages/tools-interchange-contract",
] as const;

/** Committed index read at runtime by `@workbench/tool-manifest` / `@workbench/agents`. */
export const COMMITTED_TOOL_MANIFESTS_DIR = "apps/hub/generated/tool-manifests";

/** Minimal sidecar image paths for committed-index resolution (not full hub source). */
export const SIDECAR_TOOL_MANIFEST_RUNTIME_COPY_DIRS = [
  "packages/tool-manifest",
  COMMITTED_TOOL_MANIFESTS_DIR,
] as const;

export function dockerfileDirectoryCopyLines(
  dirs: readonly string[],
): string[] {
  return dirs.map((dir) => `COPY ${dir}/ ${dir}/`);
}

const HUB_SOURCE_EXCLUDED_TOOL_DIRS = new Set([
  "packages/tools-interchange-contract",
]);

/**
 * Discovery is build-time-only (see `@workbench/tool-manifest/discover`) and
 * cannot be called from here — this package is reachable from the web app's
 * browser bundle (`@workbench/agents/browser`), and Vite shims `node:fs` to
 * an empty module (see `packages/agents/src/browser-node-free.test.ts`).
 * Callers discover the real directories and pass them in.
 */
export function toolPackageDirsForDockerfiles(
  discoveredToolPackageDirs: readonly string[],
): string[] {
  return [
    ...discoveredToolPackageDirs,
    ...DOCKERFILE_TOOL_MANIFEST_EXTRA_DIRS,
  ].sort();
}

export function dockerfileManifestCopyLines(
  packageDirs: readonly string[],
): string[] {
  return packageDirs.map((dir) => `COPY ${dir}/package.json ${dir}/`);
}

// `packages/tools-*` and `workflows/*` are both valid tool-source homes
// (CL-4463) — a workflow package must get an explicit full-source COPY line
// exactly like a `packages/tools-*` one does, so this stays correct even if
// the wholesale `COPY workflows/ workflows/` line in apps/hub/Dockerfile is
// ever narrowed to per-package lines for build-cache reasons.
function isHubToolSourceDir(dir: string): boolean {
  return (
    (dir.startsWith("packages/tools-") || dir.startsWith("workflows/")) &&
    !HUB_SOURCE_EXCLUDED_TOOL_DIRS.has(dir)
  );
}

export function dockerfileHubSourceCopyLines(
  packageDirs: readonly string[],
): string[] {
  return packageDirs
    .filter(isHubToolSourceDir)
    .sort()
    .map((dir) => `COPY ${dir}/ ${dir}/`);
}

export function extractDockerfileLines(
  dockerfileText: string,
  predicate: (line: string) => boolean,
): string[] {
  return dockerfileText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("COPY ") && predicate(line));
}

export interface ExplicitMemberCopy {
  kind: "manifest" | "source";
  dir: string;
}

/**
 * The workspace-member directory and kind an explicit per-member COPY line
 * names as both source and destination — `COPY <dir>/package.json <dir>/`
 * (`kind: "manifest"`) or `COPY <dir>/ <dir>/` (`kind: "source"`) — or `null`
 * if `line` is not that shape. Deliberately excludes a bare group-wide
 * wholesale sweep like `COPY workflows/ workflows/` (no member segment, so
 * `dir` would contain no `/`): that line intentionally covers every member of
 * the group at once and is never itself an "explicit" per-package line a
 * generator emits. Kind matters, not just dir: a manifest line and a
 * full-source line for the same dir are different generator outputs, and a
 * candidate check for one must not match the other's line shape.
 */
export function explicitMemberCopy(line: string): ExplicitMemberCopy | null {
  const manifestMatch = /^COPY (.+)\/package\.json (.+)\/$/.exec(line);
  if (manifestMatch && manifestMatch[1] === manifestMatch[2]) {
    return { kind: "manifest", dir: manifestMatch[1] };
  }
  const sourceMatch = /^COPY (.+)\/ (.+)\/$/.exec(line);
  if (
    sourceMatch &&
    sourceMatch[1] === sourceMatch[2] &&
    sourceMatch[1].includes("/")
  ) {
    return { kind: "source", dir: sourceMatch[1] };
  }
  return null;
}

export interface DockerfileToolCopyDiff {
  missing: string[];
  extra: string[];
}

/**
 * Both directions of the Dockerfile/generator invariant:
 * - `missing`: every line the generator expects must literally be present.
 * - `extra`: no line that structurally looks like a tool-package copy
 *   (per `isCandidateLine`) may survive in the Dockerfile once the generator
 *   no longer expects it — e.g. a leftover line for a package that was
 *   renamed or removed. `isCandidateLine` scopes the `extra` direction only;
 *   `missing` needs no scoping since it just checks literal presence.
 */
export function diffDockerfileToolCopyLines(
  dockerfileCopyLines: readonly string[],
  expectedLines: readonly string[],
  isCandidateLine: (line: string) => boolean,
): DockerfileToolCopyDiff {
  const presentSet = new Set(dockerfileCopyLines);
  const expectedSet = new Set(expectedLines);
  const missing = expectedLines.filter((line) => !presentSet.has(line));
  const extra = dockerfileCopyLines.filter(
    (line) => isCandidateLine(line) && !expectedSet.has(line),
  );
  return { missing, extra };
}
