// Lints only files that are staged, unstaged, or untracked relative to the
// working tree — never touches files that have no pending changes. This
// mirrors `bun run format`'s scoping (scripts/format-changed.ts) so the
// documented gate is actually runnable on a normal branch instead of walking
// the whole repo (including interchange/) on every invocation.
//
// Uses `git diff --name-only --diff-filter=ACMR` for tracked changes plus
// `git ls-files --others --exclude-standard` for untracked files, then runs
// `prettier --check` and `eslint` against the filtered subset. A no-op when
// the tree is clean. Repo-wide invariant checks (lint:no-effect-fetch,
// tool-manifest drift) are not file-scoped and stay in `bun run lint:all`.

import { $ } from "bun";

const PRETTIER_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".yaml",
  ".yml",
]);

const ESLINT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

async function changedFiles(): Promise<string[]> {
  const [staged, unstaged, untracked] = await Promise.all([
    $`git diff --name-only --diff-filter=ACMR --cached`.text(),
    $`git diff --name-only --diff-filter=ACMR`.text(),
    $`git ls-files --others --exclude-standard`.text(),
  ]);

  const all = new Set<string>();
  for (const line of [staged, unstaged, untracked]) {
    for (const f of line.split("\n")) {
      const trimmed = f.trim();
      if (trimmed) all.add(trimmed);
    }
  }

  return [...all];
}

function byExtension(files: string[], extensions: Set<string>): string[] {
  return files.filter((f) => {
    const dot = f.lastIndexOf(".");
    return dot !== -1 && extensions.has(f.slice(dot));
  });
}

const changed = await changedFiles();

if (changed.length === 0) {
  console.log("lint: no changed files to lint");
  process.exit(0);
}

const prettierFiles = byExtension(changed, PRETTIER_EXTENSIONS);
const eslintFiles = byExtension(changed, ESLINT_EXTENSIONS);

if (prettierFiles.length > 0) {
  console.log(`lint: checking format of ${prettierFiles.length} file(s)`);
  await $`bunx prettier --check ${prettierFiles}`;
}

if (eslintFiles.length > 0) {
  console.log(`lint: eslint on ${eslintFiles.length} file(s)`);
  await $`bunx eslint ${eslintFiles}`;
}
