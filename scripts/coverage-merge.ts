/**
 * Merge per-workspace lcov reports into a single monorepo line-coverage number.
 *
 * Each workspace emits coverage/lcov.info when run with `bun test --coverage
 * --coverage-reporter=lcov`. Two things make a naive sum wrong:
 *
 *   1. Bun instruments every file imported during a test run, so a workspace's
 *      lcov includes interchange/ and other @workbench packages it imports.
 *   2. The same source file therefore appears in several workspaces' reports.
 *
 * So we resolve each SF path against its workspace dir, drop vendored/test
 * files, and union line hits per absolute path: a line is covered if any test
 * run anywhere hit it, and each instrumented line is counted exactly once.
 *
 * Bun's lcov carries no per-function records (only FNF/FNH summaries), so
 * functions cannot be unioned across runs; line coverage is the reported
 * metric and is what the 98.5% target refers to.
 */
import { resolve } from 'node:path';

import { Glob } from 'bun';

export interface ParsedFile {
  file: string;
  lines: Array<[number, number]>;
}

export interface LcovSource {
  baseDir: string;
  content: string;
}

export interface CoverageSummary {
  linesFound: number;
  linesHit: number;
  linePct: number;
}

const EXCLUDE_DIRS = ['/interchange/', '/node_modules/'];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export function shouldExclude(absPath: string): boolean {
  if (EXCLUDE_DIRS.some((dir) => absPath.includes(dir))) return true;
  return TEST_FILE.test(absPath);
}

export function parseLcov(content: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3), lines: [] };
    } else if (!current) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [no, count] = line.slice(3).split(',');
      current.lines.push([Number(no), Number(count)]);
    } else if (line === 'end_of_record') {
      files.push(current);
      current = null;
    }
  }

  return files;
}

/** Map of absolute file path -> (line number -> max hit count across runs). */
export type MergedCoverage = Map<string, Map<number, number>>;

export function mergeCoverage(sources: LcovSource[]): MergedCoverage {
  const merged: MergedCoverage = new Map();

  for (const { baseDir, content } of sources) {
    for (const parsed of parseLcov(content)) {
      const absPath = resolve(baseDir, parsed.file);
      if (shouldExclude(absPath)) continue;

      let fileLines = merged.get(absPath);
      if (!fileLines) {
        fileLines = new Map();
        merged.set(absPath, fileLines);
      }
      for (const [no, count] of parsed.lines) {
        fileLines.set(no, Math.max(fileLines.get(no) ?? 0, count));
      }
    }
  }

  return merged;
}

export function summarize(merged: MergedCoverage): CoverageSummary {
  let linesFound = 0;
  let linesHit = 0;
  for (const fileLines of merged.values()) {
    for (const count of fileLines.values()) {
      linesFound += 1;
      if (count > 0) linesHit += 1;
    }
  }
  const linePct = linesFound === 0 ? 100 : (linesHit / linesFound) * 100;
  return { linesFound, linesHit, linePct };
}

export function formatSummary(summary: CoverageSummary): string {
  return `Lines: ${summary.linePct.toFixed(2)}% (${summary.linesHit}/${summary.linesFound})`;
}

async function main(): Promise<void> {
  const threshold = Number(process.env.COVERAGE_THRESHOLD ?? '0');
  const glob = new Glob('**/coverage/lcov.info');
  const sources: LcovSource[] = [];

  for await (const path of glob.scan({ dot: false })) {
    if (path.includes('interchange/') || path.includes('node_modules/')) continue;
    // path is <workspace>/coverage/lcov.info; the workspace dir is two up.
    const baseDir = resolve(path, '..', '..');
    sources.push({ baseDir, content: await Bun.file(path).text() });
  }

  if (sources.length === 0) {
    console.error('No coverage/lcov.info reports found. Run `bun run test:coverage` first.');
    process.exit(1);
  }

  const summary = summarize(mergeCoverage(sources));
  console.log(`Merged ${sources.length} workspace report(s)`);
  console.log(formatSummary(summary));

  if (summary.linePct + 1e-9 < threshold) {
    console.error(`\nLine coverage ${summary.linePct.toFixed(2)}% is below target ${threshold}%`);
    process.exit(1);
  }
  console.log(`\nLine coverage meets target (${threshold}%)`);
}

if (import.meta.main) {
  await main();
}
