// Regenerates `.changeset/config.json`'s `ignore` list from the
// workspace's actual `private` flags (CL-8167). Run this after adding a
// package or flipping one's `private` flag; `bun run check:structural
// changeset-ignore` fails when the checked-in file has drifted from
// what this script would produce.
import { listUnpublishablePackageNames } from "./lib/publishable-packages.ts";

export async function buildChangesetConfig(root: string): Promise<object> {
  const ignore = await listUnpublishablePackageNames(root);
  return {
    $schema: "https://unpkg.com/@changesets/config@3.0.0/schema.json",
    changelog: "@changesets/cli/changelog",
    commit: false,
    fixed: [],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependents: "always",
    ignore,
  };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const config = await buildChangesetConfig(root);
  await Bun.write(
    `${root}/.changeset/config.json`,
    `${JSON.stringify(config, null, 2)}\n`,
  );
  console.log("wrote .changeset/config.json");
}

if (import.meta.main) await main();
