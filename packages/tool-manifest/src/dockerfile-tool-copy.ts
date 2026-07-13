import { loadCommittedToolManifestFactories } from "./committed-index";
import { deriveToolPackageSpecs } from "./derive";

export const DOCKERFILE_TOOL_MANIFEST_EXTRA_DIRS = [
  "packages/tool-manifest",
  "packages/tools-catalog",
  "packages/tools-interchange-contract",
] as const;

const HUB_SOURCE_EXCLUDED_TOOL_DIRS = new Set([
  "packages/tools-interchange-contract",
]);

export function toolPackageDirsForDockerfiles(): string[] {
  const fromManifests = deriveToolPackageSpecs(
    loadCommittedToolManifestFactories(),
  ).map((spec) => spec.packageDir);
  return [...fromManifests, ...DOCKERFILE_TOOL_MANIFEST_EXTRA_DIRS].sort();
}

export function dockerfileManifestCopyLines(
  packageDirs: readonly string[],
): string[] {
  return packageDirs.map((dir) => `COPY ${dir}/package.json ${dir}/`);
}

export function dockerfileHubSourceCopyLines(
  packageDirs: readonly string[],
): string[] {
  return packageDirs
    .filter(
      (dir) =>
        dir.startsWith("packages/tools-") &&
        !HUB_SOURCE_EXCLUDED_TOOL_DIRS.has(dir),
    )
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
