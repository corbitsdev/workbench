// `bun run release` — publishes every publishable @corbits workflow and
// tool package whose local version is newer than what's already on npm
// (CL-8167). Run by .github/workflows/publish.yml after a changesets
// version PR merges; `--dry-run` (used by CI's publish-dry-run job and
// by `bun run release -- --dry-run` locally) packs and validates every
// package with `npm publish --dry-run` without publishing or requiring
// a token.
//
// Never reads NPM_TOKEN (or any credential) from a file — CI passes it
// as an environment variable, which npm's own CLI reads from
// NODE_AUTH_TOKEN / npm config, never something this script parses off
// disk.
import { $ } from "bun";
import { listPublishablePackages } from "./lib/publishable-packages.ts";

type PublishedVersionLookup = (name: string) => Promise<string | undefined>;

async function fetchPublishedVersion(
  name: string,
): Promise<string | undefined> {
  const result = await $`npm view ${name} version`.quiet().nothrow();
  if (result.exitCode !== 0) return undefined;
  const version = result.stdout.toString().trim();
  return version.length > 0 ? version : undefined;
}

export interface RunReleaseOptions {
  root: string;
  dryRun: boolean;
  log?: (line: string) => void;
  lookupPublishedVersion?: PublishedVersionLookup;
}

export async function runRelease(options: RunReleaseOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const lookupPublishedVersion =
    options.lookupPublishedVersion ?? fetchPublishedVersion;
  const packages = await listPublishablePackages(options.root);

  for (const pkg of packages) {
    const publishedVersion = options.dryRun
      ? undefined
      : await lookupPublishedVersion(pkg.name);

    if (!options.dryRun && publishedVersion === pkg.version) {
      log(`skip ${pkg.name}@${pkg.version} — already published`);
      continue;
    }

    const cwd = `${options.root}/${pkg.dir}`;
    log(
      options.dryRun
        ? `dry-run pack + publish --dry-run ${pkg.name}@${pkg.version}`
        : `pack + publish ${pkg.name}@${pkg.version} (was ${publishedVersion ?? "unpublished"})`,
    );

    await $`bun pm pack`.cwd(cwd).quiet();

    if (options.dryRun) {
      await $`npm publish --dry-run --access public`.cwd(cwd).quiet();
    } else {
      await $`npm publish --provenance --access public`.cwd(cwd).quiet();
    }
  }
}

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  await runRelease({ root: process.cwd(), dryRun });
}

if (import.meta.main) await main();
