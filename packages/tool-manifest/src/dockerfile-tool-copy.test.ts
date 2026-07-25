import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverToolPackageDirs } from "./discover";
import {
  diffDockerfileToolCopyLines,
  dockerfileDirectoryCopyLines,
  dockerfileHubSourceCopyLines,
  dockerfileManifestCopyLines,
  explicitMemberCopy,
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

const ALL_COPY_LINES = (): boolean => true;

// A `packages/tools-*` (or the hand-maintained extra) directory is *always*
// a tool package by repo naming convention — no non-tool package ever uses
// that prefix — so it is safe to treat any such explicit COPY line the
// generator does not expect as a stale leftover (e.g. a rename/removal).
function isPackagesToolConventionDir(dir: string): boolean {
  return (
    dir.startsWith("packages/tools-") ||
    dir === "packages/tool-manifest" ||
    dir === "packages/tools-interchange-contract"
  );
}

// Manifest lines exist for every workspace member regardless of tool status
// (AGENTS.md: the manifest-copy section lists every member, not just tool
// ones), so a `workflows/*` manifest line is not on its own evidence of a
// tool package — only the `packages/tools-*` convention is safe to flag here.
function isManifestToolCopyCandidate(line: string): boolean {
  const copy = explicitMemberCopy(line);
  return (
    copy !== null &&
    copy.kind === "manifest" &&
    isPackagesToolConventionDir(copy.dir)
  );
}

// Unlike manifest lines, an *individual* full-source COPY line for a
// `workflows/*` member only ever exists because `dockerfileHubSourceCopyLines`
// emitted it for a tool-shipping workflow — a non-tool workflow relies solely
// on the wholesale `COPY workflows/ workflows/` sweep and never gets an
// explicit line of its own. So any explicit `workflows/*` full-source line is
// safe to treat as a tool-copy candidate. On the packages/ side, scope to
// exactly the `packages/tools-*` naming convention (mirroring
// `isHubToolSourceDir`) — NOT the broader `isPackagesToolConventionDir`,
// which also covers `packages/tool-manifest`: that package gets its own
// full-source COPY line for unrelated reasons (it's a genuine hub runtime
// dependency), not because the tool-copy generator emitted it, so it must
// not be treated as a tool-copy candidate here.
function isHubSourceToolCopyCandidate(line: string): boolean {
  const copy = explicitMemberCopy(line);
  if (copy === null || copy.kind !== "source") return false;
  return (
    copy.dir.startsWith("packages/tools-") || copy.dir.startsWith("workflows/")
  );
}

describe("Dockerfile tool COPY blocks vs committed manifests", () => {
  const dirs = toolPackageDirsForDockerfiles(
    discoverToolPackageDirs(repoRoot()),
  );
  const expectedManifest = dockerfileManifestCopyLines(dirs);
  const expectedHubSource = dockerfileHubSourceCopyLines(dirs);

  test("hub manifest COPY lines match derived tool packages", () => {
    const hub = readDockerfile("apps/hub/Dockerfile");
    const allCopyLines = extractDockerfileLines(hub, ALL_COPY_LINES);
    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expectedManifest,
      isManifestToolCopyCandidate,
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
  });

  test("sidecar manifest COPY lines match derived tool packages", () => {
    const sidecar = readDockerfile("apps/sidecar/Dockerfile");
    const allCopyLines = extractDockerfileLines(sidecar, ALL_COPY_LINES);
    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expectedManifest,
      isManifestToolCopyCandidate,
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
  });

  test("web manifest COPY lines match derived tool packages", () => {
    const web = readDockerfile("apps/web/Dockerfile");
    const allCopyLines = extractDockerfileLines(web, ALL_COPY_LINES);
    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expectedManifest,
      isManifestToolCopyCandidate,
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
  });

  test("hub full-source COPY lines match derived @workbench/tools-* packages", () => {
    const hub = readDockerfile("apps/hub/Dockerfile");
    const allCopyLines = extractDockerfileLines(hub, ALL_COPY_LINES);
    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expectedHubSource,
      isHubSourceToolCopyCandidate,
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
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
// COPY-line invariant holds for that group too — not just
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

// Proves the `extra` direction of diffDockerfileToolCopyLines actually
// fails when it should — a leftover COPY line for a renamed/removed tool
// package must be reported, not silently ignored the way plain membership
// filtering would (membership only ever shrinks `actual`, so it can never
// surface a line that shouldn't be there).
describe("diffDockerfileToolCopyLines reports leftover COPY lines", () => {
  test("flags a stale packages/tools-* manifest COPY line the generator no longer expects", () => {
    const dockerfileText = [
      "COPY packages/tools-artifact/package.json packages/tools-artifact/",
      "COPY packages/tools-deleted-thing/package.json packages/tools-deleted-thing/",
    ].join("\n");
    const allCopyLines = extractDockerfileLines(dockerfileText, ALL_COPY_LINES);
    const expected = dockerfileManifestCopyLines(["packages/tools-artifact"]);

    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expected,
      isManifestToolCopyCandidate,
    );

    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([
      "COPY packages/tools-deleted-thing/package.json packages/tools-deleted-thing/",
    ]);
  });

  test("flags a stale workflows/* full-source COPY line the generator no longer expects", () => {
    const dockerfileText = [
      "COPY workflows/exa-topic-watch/ workflows/exa-topic-watch/",
      "COPY workflows/renamed-away-workflow/ workflows/renamed-away-workflow/",
    ].join("\n");
    const allCopyLines = extractDockerfileLines(dockerfileText, ALL_COPY_LINES);
    const expected = dockerfileHubSourceCopyLines([
      "workflows/exa-topic-watch",
    ]);

    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expected,
      isHubSourceToolCopyCandidate,
    );

    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([
      "COPY workflows/renamed-away-workflow/ workflows/renamed-away-workflow/",
    ]);
  });

  test("does not flag a non-tool workflow's manifest line as extra (manifest lines exist for every member)", () => {
    const dockerfileText = [
      "COPY packages/tools-artifact/package.json packages/tools-artifact/",
      "COPY workflows/heartbeat/package.json workflows/heartbeat/",
    ].join("\n");
    const allCopyLines = extractDockerfileLines(dockerfileText, ALL_COPY_LINES);
    const expected = dockerfileManifestCopyLines(["packages/tools-artifact"]);

    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expected,
      isManifestToolCopyCandidate,
    );

    expect(diff.extra).toEqual([]);
  });

  test("does not flag the wholesale workflows/ workflows/ sweep line as extra", () => {
    const dockerfileText = [
      "COPY workflows/exa-topic-watch/ workflows/exa-topic-watch/",
      "COPY workflows/ workflows/",
    ].join("\n");
    const allCopyLines = extractDockerfileLines(dockerfileText, ALL_COPY_LINES);
    const expected = dockerfileHubSourceCopyLines([
      "workflows/exa-topic-watch",
    ]);

    const diff = diffDockerfileToolCopyLines(
      allCopyLines,
      expected,
      isHubSourceToolCopyCandidate,
    );

    expect(diff.extra).toEqual([]);
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
