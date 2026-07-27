import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  embeddedToolPackagesDir,
  integrityFromTarballBytes,
} from "../src/lib/tool-packages-embedded";
import { TOOL_PACKAGES } from "./build-tool-packages";

// Drift gate (CL-3093 Phase 1): committed generated/tool-packages must match a
// fresh pack of the live tool sources. If tools changed and
// `bun run build:tool-packages` was not re-run, this fails.
describe("committed embedded tool packages are in sync with source", () => {
  it("manifest lists exactly one row per TOOL_PACKAGES entry", async () => {
    const raw = await readFile(
      join(embeddedToolPackagesDir(), "manifest.json"),
      "utf8",
    );
    const committed = JSON.parse(raw) as { name: string }[];
    const names = committed.map((r) => r.name).sort();
    const expected = TOOL_PACKAGES.map((s) => s.name).sort();
    expect(names).toEqual(expected);
  });

  it("manifest.json matches a fresh embedded manifest computation", async () => {
    // Full pack runs in a subprocess so Bun.build does not race with other
    // in-process pack tests (see build-tool-packages.test.ts).
    const proc = Bun.spawn(
      ["bun", "run", "bin/build-tool-packages.ts", "--print-manifest"],
      {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const expected = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`--print-manifest failed: ${err}`);
    }
    const actual = await readFile(
      join(embeddedToolPackagesDir(), "manifest.json"),
      "utf8",
    );
    // If this fails, run `bun run build:tool-packages` and commit the result.
    expect(actual).toBe(expected);
  }, 120_000);

  it("every manifest row has a tarball with matching integrity", async () => {
    const raw = await readFile(
      join(embeddedToolPackagesDir(), "manifest.json"),
      "utf8",
    );
    const rows = JSON.parse(raw) as {
      tarballFilename: string;
      integrity: string;
    }[];
    const tarballsDir = join(embeddedToolPackagesDir(), "tarballs");
    const onDisk = (await readdir(tarballsDir)).filter((f) =>
      f.endsWith(".tgz"),
    );
    expect(onDisk.sort()).toEqual(rows.map((r) => r.tarballFilename).sort());
    for (const row of rows) {
      const bytes = await readFile(join(tarballsDir, row.tarballFilename));
      expect(integrityFromTarballBytes(bytes)).toBe(row.integrity);
    }
  });
});

function hubDockerfilePath(): string {
  const binDir = dirname(fileURLToPath(import.meta.url));
  return join(dirname(binDir), "Dockerfile");
}

const HUB_IMAGE_EMBED_RUN =
  /RUN bun run --cwd apps\/hub build:tool-manifests && \\\n\s+bun run --cwd apps\/hub check:tool-manifest-drift && \\\n\s+bun run --cwd apps\/hub check:workflow-defs-drift && \\\n\s+bun run --cwd apps\/hub build:workflow-defs && \\\n\s+bun run --cwd apps\/hub build:tool-packages/;

describe("hub Docker image can run build:tool-packages", () => {
  it("rebuilds workflow defs, tool manifests, and embedded tarballs in one image-build RUN", async () => {
    const dockerfile = await readFile(hubDockerfilePath(), "utf8");
    expect(dockerfile).toMatch(HUB_IMAGE_EMBED_RUN);
  });
});
