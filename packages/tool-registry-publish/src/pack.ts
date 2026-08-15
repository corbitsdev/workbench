// Packs one `@corbits/*-tools` package directory into a self-contained
// npm-style tarball fit for a `package-registry` asset's `tarballs/`
// tree (vendor/intx/hub-sessions/src/package-registry-kind.ts).
//
// The source packages ship raw TypeScript behind a workspace `exports`
// field and depend on other workspace packages (`@intx/agent`,
// `@intx/types`, `arktype`, ...) via `workspace:`/`catalog:` specs that
// only resolve inside this monorepo. A tarball can carry neither, so
// each package's entry module is bundled with every dependency inlined
// into one plain ESM file — the tarball then declares no
// `dependencies` at all, and the closure resolver has nothing further
// to fetch. `interchange.tools` on the synthesized `package.json`
// points at that bundle, matching the shape
// `vendor/intx/tool-packaging/src/loader.ts` reads.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

const BUNDLE_ENTRY_FILENAME = "tool.mjs";

export type PackedTarball = {
  name: string;
  version: string;
  filename: string;
  bytes: Uint8Array;
};

/** The tarball filename convention `scripts/checks/packages.ts` uses for `bun pm pack` output, reused here for the packer's own tarballs. */
export function tarballFilenameFor(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

type PackageManifest = {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
};

function entryFileFor(manifest: PackageManifest, packageDir: string): string {
  const entry = manifest.exports?.["."];
  if (typeof entry !== "string" || !entry.startsWith("./")) {
    throw new Error(
      `packToolPackageTarball: ${manifest.name}'s package.json has no "." exports entry to bundle`,
    );
  }
  return path.join(packageDir, entry);
}

// Concurrent overlapping seed runs (two racing "finish setup" requests
// for the same tenant, in particular) would otherwise spawn two "bun
// build" subprocesses for the same entrypoint at the same time. The
// packed result for a given `packageDir` is deterministic for this
// process's lifetime — its source only changes across a restart — so
// coalescing concurrent calls into one in-flight build, and reusing a
// completed one, is both correct and strictly less work.
const packCache = new Map<string, Promise<PackedTarball>>();

/**
 * Reads `packageDir`'s `package.json` for name/version and its "."
 * export as the bundle entrypoint, bundles that entrypoint with the
 * `bun build` CLI (no externals — every dependency inlined), and tars
 * the result into `package/package.json` + `package/tool.mjs`,
 * matching the layout `extractTarballPackageJSON` and npm itself
 * expect.
 */
export async function packToolPackageTarball(
  packageDir: string,
): Promise<PackedTarball> {
  const cached = packCache.get(packageDir);
  if (cached !== undefined) return cached;
  const pending = packToolPackageTarballUncached(packageDir).catch(
    (err: unknown) => {
      // A failed build must not poison future calls — only a
      // successful, reusable result stays cached.
      packCache.delete(packageDir);
      throw err;
    },
  );
  packCache.set(packageDir, pending);
  return pending;
}

// `Bun.build()` called in-process has been observed to fail
// nondeterministically — a bundler-internal "Unexpected reading file"
// on a package this exact process had already loaded fine moments
// earlier — once the calling process has itself transpiled a large
// module graph (this monorepo's own onboarding/hub-client/e2e code, in
// particular) and other `bun` processes (a spawned hub, a spawned
// sidecar) are alive alongside it. Shelling out to the `bun build` CLI
// as an isolated subprocess sidesteps whatever shared, reentrant
// bundler state the in-process API call was tripping over — the same
// reason `scripts/checks/packages.ts` shells out to `bun pm pack`
// rather than calling a pack API in-process.
async function runBunBuild(
  entrypoint: string,
  outfile: string,
  packageName: string,
): Promise<void> {
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      entrypoint,
      "--target=bun",
      "--format=esm",
      `--outfile=${outfile}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `packToolPackageTarball: "bun build" failed for ${packageName} (exit ${String(exitCode)}): ${stderr}`,
    );
  }
}

async function packToolPackageTarballUncached(
  packageDir: string,
): Promise<PackedTarball> {
  const manifest = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8"),
  ) as PackageManifest;

  const bundleStagingDir = await mkdtemp(
    path.join(tmpdir(), "corbits-tools-bundle-"),
  );
  let bundleBytes: Uint8Array;
  try {
    const outfile = path.join(bundleStagingDir, BUNDLE_ENTRY_FILENAME);
    await runBunBuild(
      entryFileFor(manifest, packageDir),
      outfile,
      manifest.name,
    );
    bundleBytes = new Uint8Array(await readFile(outfile));
  } finally {
    await rm(bundleStagingDir, { recursive: true, force: true });
  }

  const tarballPackageJSON = {
    name: manifest.name,
    version: manifest.version,
    interchange: { tools: `./${BUNDLE_ENTRY_FILENAME}` },
  };

  const stagingRoot = await mkdtemp(path.join(tmpdir(), "corbits-tools-pack-"));
  try {
    const packageStagingDir = path.join(stagingRoot, "package");
    await mkdir(packageStagingDir, { recursive: true });
    await writeFile(
      path.join(packageStagingDir, "package.json"),
      JSON.stringify(tarballPackageJSON, null, 2),
    );
    await writeFile(
      path.join(packageStagingDir, BUNDLE_ENTRY_FILENAME),
      bundleBytes,
    );

    const tarballPath = path.join(stagingRoot, "out.tgz");
    await tar.create({ cwd: stagingRoot, gzip: true, file: tarballPath }, [
      "package",
    ]);
    const bytes = new Uint8Array(await readFile(tarballPath));
    return {
      name: manifest.name,
      version: manifest.version,
      filename: tarballFilenameFor(manifest.name, manifest.version),
      bytes,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
