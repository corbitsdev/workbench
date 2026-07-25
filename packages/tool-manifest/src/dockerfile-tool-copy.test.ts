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

function sorted(lines: string[]): string[] {
  return [...lines].sort();
}

// `workflows/*` is a valid tool-source home alongside `packages/tools-*`
// (CL-4463/CL-4465 — several workflows now ship their own private tools),
// but MOST `workflows/*` package.json COPY lines belong to workflows that
// ship no tools at all (every workspace member gets one, per the
// `--frozen-lockfile` manifest-copy rule) — so a prefix/regex predicate over
// `workflows/` can't tell a tool-shipping workflow's COPY line from any
// other's. Matching directly against the derived `expected*` line sets (the
// same pattern the "sidecar ships tool-manifest package" test below already
// uses) ties the predicate to the actual discovered tool packages instead.
function lineSetPredicate(expected: readonly string[]) {
  const expectedSet = new Set(expected);
  return (line: string): boolean => expectedSet.has(line);
}

describe("Dockerfile tool COPY blocks vs committed manifests", () => {
  const dirs = toolPackageDirsForDockerfiles(discoverToolPackageDirs(repoRoot()));
  const expectedManifest = dockerfileManifestCopyLines(dirs);
  const expectedHubSource = dockerfileHubSourceCopyLines(dirs);
  const TOOL_MANIFEST_COPY_PREDICATE = lineSetPredicate(expectedManifest);
  const HUB_TOOL_SOURCE_PREDICATE = lineSetPredicate(expectedHubSource);

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

// Several `workflows/*` tool packages are committed now (exa-topic-watch,
// competitor-analysis, firecrawl-url-watch, github-topic-watch, heartbeat,
// reddit-opportunity-watch, sumble-account-intel — CL-4463/CL-4465), and the
// two real-Dockerfile suites above already exercise that path via their
// predicates. These synthetic-fixture tests additionally pin the generator
// FUNCTIONS directly, independent of what happens to be committed, so the
// COPY-line invariant for `workflows/*` (CL-4463) — not just
// `packages/tools-*` — stays covered even if every real workflow tool
// package were removed. Without this, a workflow-shipped tool's hub-image
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
