// check:hub-git-safety — fail when this branch carries a commit authored
// by the hub's own git-on-disk machinery (or a seed/deploy test that
// inherited the working tree's GIT_DIR / HUB_DATA_DIR). Those commits
// have landed on the working branch and wiped checkouts; catching them
// in CI is cheaper than reconstructing a deleted worktree.
import { spawnSync } from "node:child_process";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

export const JUNK_COMMIT_SUBJECTS = [
  "initial @corbits/fake-tools@0.0.1",
  "seed v1",
  "Deploy the default workflow definition",
] as const;

export const JUNK_AUTHOR_EMAILS = [
  "hub@interchange.local",
  "seed@workbench.localhost",
] as const;

/** A commit touching this many paths with no source-tree file is hub dump. */
export const LARGE_COMMIT_FILE_THRESHOLD = 50;

const SOURCE_PATH =
  /^(apps|packages|scripts|workflows|docs|test|tools|\.github)\//;

export type InspectedCommit = {
  readonly hash: string;
  readonly subject: string;
  readonly authorEmail: string;
  readonly files: readonly string[];
};

export function isSourcePath(file: string): boolean {
  return SOURCE_PATH.test(file) && !file.includes(".data/");
}

export function auditHubJunkCommits(
  commits: readonly InspectedCommit[],
): CheckReport {
  const report = emptyReport();
  for (const commit of commits) {
    const short = commit.hash.slice(0, 8);
    if ((JUNK_COMMIT_SUBJECTS as readonly string[]).includes(commit.subject)) {
      report.violations.push(
        `${short}: subject ${JSON.stringify(commit.subject)} is hub/seed ` +
          `git-on-disk machinery, not a workbench change. Reset that commit ` +
          `off the branch; tests must use a disposable HUB_DATA_DIR outside ` +
          `this work tree (test/disposable-hub-data-dir.ts).`,
      );
    }
    if (
      (JUNK_AUTHOR_EMAILS as readonly string[]).includes(commit.authorEmail)
    ) {
      report.violations.push(
        `${short}: author ${commit.authorEmail} is hub/seed git identity ` +
          `(subject ${JSON.stringify(commit.subject)}). That commit is ` +
          `on-disk hub state, not a workbench change.`,
      );
    }
    const dataFiles = commit.files.filter(
      (file) => file === ".data" || file.startsWith(".data/"),
    );
    if (dataFiles.length > 0) {
      report.violations.push(
        `${short}: commits hub data paths (${dataFiles.slice(0, 3).join(", ")}` +
          `${dataFiles.length > 3 ? `, … +${dataFiles.length - 3}` : ""}). ` +
          `HUB_DATA_DIR must not live inside this work tree.`,
      );
    }
    if (
      commit.files.length > LARGE_COMMIT_FILE_THRESHOLD &&
      !commit.files.some(isSourcePath)
    ) {
      report.violations.push(
        `${short}: touches ${commit.files.length} paths with no corresponding ` +
          `source-tree change — the shape of a hub git-on-disk dump onto the ` +
          `working branch.`,
      );
    }
  }
  return report;
}

function git(root: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function resolveBaseRef(
  root: string,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return git(root, ["merge-base", "HEAD", "origin/main"]);
}

export function readCommitsSince(
  root: string,
  baseRef: string,
): InspectedCommit[] {
  const hashes = git(root, ["log", "--format=%H", `${baseRef}..HEAD`]);
  if (hashes === undefined || hashes === "") return [];
  const commits: InspectedCommit[] = [];
  for (const hash of hashes.split("\n")) {
    if (hash === "") continue;
    const meta = git(root, ["log", "-1", "--format=%s%n%ae", hash]);
    if (meta === undefined) continue;
    const newline = meta.indexOf("\n");
    const subject = newline === -1 ? meta : meta.slice(0, newline);
    const authorEmail = newline === -1 ? "" : meta.slice(newline + 1);
    const names = git(root, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      hash,
    ]);
    commits.push({
      hash,
      subject,
      authorEmail,
      files: names === undefined || names === "" ? [] : names.split("\n"),
    });
  }
  return commits;
}

function main(): void {
  const root = rootFromArgs(Bun.argv.slice(2));
  const baseRef = resolveBaseRef(root, process.env["CHECK_BASE_REF"]);
  if (baseRef === undefined) {
    const report = emptyReport();
    report.notes.push(
      "no base ref (no origin/main, no CHECK_BASE_REF); skipping — CI " +
        "supplies the base ref for the authoritative run",
    );
    reportAndExit("check:hub-git-safety", report);
  }
  const commits = readCommitsSince(root, baseRef);
  const report = auditHubJunkCommits(commits);
  report.notes.push(`${commits.length} commit(s) since ${baseRef.slice(0, 8)}`);
  reportAndExit("check:hub-git-safety", report);
}

if (import.meta.main) main();
