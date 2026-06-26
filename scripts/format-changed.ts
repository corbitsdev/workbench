// Formats only files that are staged, unstaged, or untracked relative to the
// working tree — never touches files that have no pending changes. This is the
// default `bun run format` behaviour so that routine formatting commits don't
// rewrite unrelated checked-in files (e.g. docs/).
//
// Uses `git diff --name-only --diff-filter=ACMR` for tracked changes plus
// `git ls-files --others --exclude-standard` for untracked files, then passes
// the filtered subset to `prettier --write`. A no-op when the tree is clean.
//
// Prettier extensions that this repo cares about (mirrors .prettierignore
// exclusions implicitly — prettier skips ignored paths on its own).

import { $ } from "bun";

const EXTENSIONS = new Set([
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

  return [...all].filter((f) => {
    const dot = f.lastIndexOf(".");
    return dot !== -1 && EXTENSIONS.has(f.slice(dot));
  });
}

const files = await changedFiles();

if (files.length === 0) {
  console.log("format: no changed files to format");
  process.exit(0);
}

console.log(`format: formatting ${files.length} changed file(s)`);
await $`bunx prettier --write ${files}`;
