import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dockerfileHubSourceCopyLines,
  dockerfileManifestCopyLines,
  extractDockerfileLines,
  toolPackageDirsForDockerfiles,
} from "./dockerfile-tool-copy";

function repoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

function readDockerfile(relativePath: string): string {
  return readFileSync(join(repoRoot(), relativePath), "utf8");
}

const TOOL_MANIFEST_COPY_PREDICATE = (line: string): boolean =>
  line.includes("/package.json packages/") &&
  (line.includes("packages/tools-") ||
    line.includes("packages/tool-manifest/") ||
    line.includes("packages/tools-interchange-contract/"));

const HUB_TOOL_SOURCE_PREDICATE = (line: string): boolean =>
  line.includes("packages/tools-") &&
  !line.includes("package.json") &&
  line.endsWith("/");

function sorted(lines: string[]): string[] {
  return [...lines].sort();
}

describe("Dockerfile tool COPY blocks vs committed manifests", () => {
  const dirs = toolPackageDirsForDockerfiles();
  const expectedManifest = dockerfileManifestCopyLines(dirs);
  const expectedHubSource = dockerfileHubSourceCopyLines(dirs);

  test("hub manifest COPY lines match derived tool packages", () => {
    const hub = readDockerfile("apps/hub/Dockerfile");
    const actual = extractDockerfileLines(hub, TOOL_MANIFEST_COPY_PREDICATE);
    expect(sorted(actual)).toEqual(sorted(expectedManifest));
  });

  test("sidecar manifest COPY lines match derived tool packages", () => {
    const sidecar = readDockerfile("apps/sidecar/Dockerfile");
    const actual = extractDockerfileLines(
      sidecar,
      TOOL_MANIFEST_COPY_PREDICATE,
    );
    expect(sorted(actual)).toEqual(sorted(expectedManifest));
  });

  test("web manifest COPY lines match derived tool packages", () => {
    const web = readDockerfile("apps/web/Dockerfile");
    const actual = extractDockerfileLines(web, TOOL_MANIFEST_COPY_PREDICATE);
    expect(sorted(actual)).toEqual(sorted(expectedManifest));
  });

  test("hub full-source COPY lines match derived @workbench/tools-* packages", () => {
    const hub = readDockerfile("apps/hub/Dockerfile");
    const actual = extractDockerfileLines(hub, HUB_TOOL_SOURCE_PREDICATE);
    expect(sorted(actual)).toEqual(sorted(expectedHubSource));
  });
});
