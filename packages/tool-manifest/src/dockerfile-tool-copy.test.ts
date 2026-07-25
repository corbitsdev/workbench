import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverToolPackageDirs } from "./discover";
import {
  dockerfileDirectoryCopyLines,
  dockerfileHubSourceCopyLines,
  dockerfileManifestCopyLines,
  extractDockerfileLines,
  SIDECAR_TOOL_MANIFEST_RUNTIME_COPY_DIRS,
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
  const dirs = toolPackageDirsForDockerfiles(discoverToolPackageDirs(repoRoot()));
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

  test("sidecar ships tool-manifest package and committed index for runtime resolution", () => {
    const sidecar = readDockerfile("apps/sidecar/Dockerfile");
    const expected = dockerfileDirectoryCopyLines(
      SIDECAR_TOOL_MANIFEST_RUNTIME_COPY_DIRS,
    );
    const actual = extractDockerfileLines(sidecar, (line) =>
      expected.includes(line),
    );
    expect(sorted(actual)).toEqual(sorted(expected));
  });
});

// No `workflows/*` tool package is committed yet, so the two real-Dockerfile
// suites above never exercise that path. These feed a synthetic
// workflows-sourced tool package directly into the generators to prove the
// COPY-line invariant holds for that group too (CL-4463) — not just
// `packages/tools-*`. Without this, a workflow-shipped tool's hub-image
// coverage would depend entirely on the wholesale `COPY workflows/
// workflows/` line staying unnarrowed, with nothing to catch it silently
// stopping.
describe("dockerfileHubSourceCopyLines covers workflows/* tool packages", () => {
  test("emits an explicit full-source COPY line for a workflows/* tool package, same as packages/tools-*", () => {
    const lines = dockerfileHubSourceCopyLines([
      "packages/tools-artifact",
      "workflows/fixture-workflow",
    ]);
    expect(sorted(lines)).toEqual([
      "COPY packages/tools-artifact/ packages/tools-artifact/",
      "COPY workflows/fixture-workflow/ workflows/fixture-workflow/",
    ]);
  });

  test("still excludes the hand-maintained hub-source exclusion list and non-tool extra dirs", () => {
    const lines = dockerfileHubSourceCopyLines([
      "packages/tools-interchange-contract",
      "packages/tool-manifest",
      "workflows/fixture-workflow",
    ]);
    expect(lines).toEqual([
      "COPY workflows/fixture-workflow/ workflows/fixture-workflow/",
    ]);
  });
});

describe("dockerfileManifestCopyLines covers workflows/* tool packages", () => {
  test("emits a package.json COPY line for a workflows/* dir the same as packages/*", () => {
    const lines = dockerfileManifestCopyLines([
      "packages/tools-artifact",
      "workflows/fixture-workflow",
    ]);
    expect(sorted(lines)).toEqual([
      "COPY packages/tools-artifact/package.json packages/tools-artifact/",
      "COPY workflows/fixture-workflow/package.json workflows/fixture-workflow/",
    ]);
  });
});

describe("toolPackageDirsForDockerfiles merges discovered dirs with the fixed extras", () => {
  test("keeps a discovered workflows/* dir alongside packages/tools-* and the extra dirs", () => {
    const dirs = toolPackageDirsForDockerfiles([
      "workflows/fixture-workflow",
      "packages/tools-artifact",
    ]);
    expect(dirs).toEqual(
      [
        "packages/tool-manifest",
        "packages/tools-artifact",
        "packages/tools-catalog",
        "packages/tools-interchange-contract",
        "workflows/fixture-workflow",
      ].sort(),
    );
  });
});
