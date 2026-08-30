// check:report-error — AGENTS.md requires every caught error to reach
// reportError(...) from @corbits/error-sink: never a bare `catch {}`,
// never a toast alone, because reportError attaches operation/tenant/
// room/agent context and a refId a person can quote to support, and
// redacts secrets before anything reaches a log sink. This check is what
// makes that rule real instead of prose sitting in a section titled
// "Conventions a check enforces" — like every script in this directory,
// it is a heuristic over source text, not proof, and a failure here is a
// claim to go verify, not a verdict.
//
// Each file is parsed with the TypeScript compiler API (already a repo
// dependency — reaching for it beats hand-rolling a brace/string matcher
// that will eventually misparse a template literal) and every `catch`
// clause is inspected. A clause passes if its body calls the file's own
// `reportError` import from `@corbits/error-sink` (bare or aliased, or
// via a `* as ns` namespace import), contains a `throw` that isn't nested
// inside another function or class body (a conditional rethrow is still a
// rethrow; a `throw` queued inside a `setTimeout` callback is not — it
// never propagates from this catch), or carries the opt-out marker below;
// anything else is a finding. Matching the import binding rather than the
// bare name `reportError` means an unrelated local function that happens
// to share the name is still flagged, and an aliased import (`import {
// reportError as report }`) is still recognized.
//
// This is still text-level triage, not control-flow analysis: a catch
// that calls a helper which calls reportError three frames down will
// false-positive, and only `try { } catch { }` statements are walked — a
// bare `.catch(...)` promise handler is out of scope until there's real
// evidence it's worth the extra surface.
//
// Deliberate exceptions already tracked by their own ticket get a narrow,
// greppable, justified opt-out: a comment containing `report-error-ignore:`
// followed by a reason, placed on the line the `catch` itself starts on or
// anywhere inside its body. There is no blanket per-file allowlist — every
// exception states its own reason next to the code it excuses. Use this
// only for a finding already in flight on a named ticket, never to clear a
// backlog entry — that's what the baseline below is for.
//
// A brand-new invariant introduced against an existing codebase can't
// demand the whole tree comply on day one, so the rest of the repo's
// findings — everything not carrying an opt-out — are recorded in
// scripts/checks/report-error-baseline.txt, a debt ledger, not an
// allowlist: every line in it is a bug someone should still fix. It is
// not a way to keep a finding quiet forever. The gate this check runs is:
//
//   - A finding not in the baseline always fails — that's a regression.
//   - A finding in the baseline fails too if this change's diff touches
//     its catch clause's line — not merely its file, since a change that
//     edits one function shouldn't be forced to also clean up unrelated
//     debt elsewhere in the same file (this check's own introducing PR is
//     the clearest example: its only edit to a file with baselined debt
//     is a report-error-ignore comment nowhere near it). Fix the debt or
//     give it its own report-error-ignore rather than let it ride along.
//   - A baseline entry with no matching finding anymore fails, so a fix
//     forces the baseline to shrink instead of quietly going stale.
//
// This follows check:tool-package-freshness's own precedent for scoping a
// new invariant to what changed rather than retroactively flagging
// pre-existing state: CI passes CHECK_BASE_REF; locally this falls back to
// the merge base with origin/main; with neither available the touched-file
// half of the gate no-ops (new-vs-baseline enforcement still applies).
//
// Regenerate the baseline after fixing (or newly opting out) entries:
//   bun run scripts/checks/report-error.ts --write-baseline
import { spawnSync } from "node:child_process";
import { Glob } from "bun";
import path from "node:path";
import ts from "typescript";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";
import { resolveBaseRef } from "./tool-package-freshness";

const SCAN_DIRS = ["apps", "packages", "workflows"];
const IGNORE_MARKER_PATTERN = /report-error-ignore:\s*(\S.*)/;
const ERROR_SINK_MODULE = "@corbits/error-sink";
export const BASELINE_PATH = "scripts/checks/report-error-baseline.txt";

const BASELINE_HEADER = [
  "# check:report-error debt ledger — NOT an allowlist.",
  "#",
  "# Every line below is a catch clause that already existed when",
  "# check:report-error started enforcing the reportError convention. It is",
  "# recorded here so new code is held to the rule immediately while the",
  "# existing backlog is tracked instead of hidden. Each line names a real",
  "# bug someone should still fix: route the catch through reportError,",
  "# rethrow it, or (for a finding already in flight on a ticket) replace",
  "# its line here with a report-error-ignore comment in the source instead.",
  "#",
  "# This file only ever shrinks: fixing an entry and regenerating removes",
  "# its line; a line with no matching finding anymore fails the check",
  "# until it's regenerated, so it can't rot silently.",
  "#",
  "# Regenerate after fixing (or newly opting out) entries:",
  "#   bun run scripts/checks/report-error.ts --write-baseline",
  "#",
  "# Format (tab-separated): <path>\\t<occurrence>\\t<evidence>",
  "# `occurrence` is this evidence string's 1-based rank among matches in",
  "# the same file — line numbers aren't used as the key because they",
  "# drift as unrelated code around a catch changes.",
  "",
].join("\n");

export interface ScannedFile {
  readonly relPath: string;
  readonly contents: string;
}

function isExcludedPath(relPath: string): boolean {
  if (relPath.includes("node_modules/")) return true;
  if (relPath.includes("/dist/") || relPath.startsWith("dist/")) return true;
  if (relPath.includes("/vendor/") || relPath.startsWith("vendor/")) {
    return true;
  }
  if (relPath.includes("/test/") || relPath.startsWith("test/")) return true;
  if (/\.(test|spec)\.tsx?$/.test(relPath)) return true;
  return false;
}

export async function scanFiles(
  root: string,
  dirs: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    const glob = new Glob(`${dir}/**/*.{ts,tsx}`);
    for await (const file of glob.scan({ cwd: root, dot: false })) {
      if (isExcludedPath(file)) continue;
      files.push(file);
    }
  }
  return files;
}

export interface ReportErrorBindings {
  /** Local names bound to the named `reportError` export, e.g. from
   * `import { reportError }` or `import { reportError as report }`. */
  readonly localNames: ReadonlySet<string>;
  /** Local names bound to a `* as ns` namespace import of the module,
   * so `ns.reportError(...)` is recognized too. */
  readonly namespaceNames: ReadonlySet<string>;
}

/**
 * Finds this file's own binding(s) for `@corbits/error-sink`'s
 * `reportError` export. Matching against these bindings — rather than
 * the bare identifier `reportError` — means an unrelated local function
 * that happens to share the name doesn't pass, and an aliased import
 * still does.
 */
export function findReportErrorBindings(
  sourceFile: ts.SourceFile,
): ReportErrorBindings {
  const localNames = new Set<string>();
  const namespaceNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== ERROR_SINK_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaceNames.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      if (importedName === "reportError") localNames.add(element.name.text);
    }
  }
  return { localNames, namespaceNames };
}

function callsReportError(
  node: ts.Node,
  bindings: ReportErrorBindings,
): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && bindings.localNames.has(callee.text)) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "reportError" &&
        ts.isIdentifier(callee.expression) &&
        bindings.namespaceNames.has(callee.expression.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A nested function or class body's own control flow doesn't run
 * synchronously as part of the catch: a `throw` inside a `setTimeout`
 * callback or an unrelated closure never rethrows the caught error, it
 * schedules an unhandleable exception on a later tick (or throws over
 * unrelated data entirely) — so the search doesn't descend into one.
 */
function containsThrow(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isThrowStatement(n)) {
      found = true;
      return;
    }
    if (
      ts.isFunctionLike(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n)
    ) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Searches the whole enclosing try statement, not just the catch clause:
 * the natural place to write "the next line is a deliberate empty catch"
 * is the line above it, which sits inside the try block's trailing
 * trivia rather than the catch clause's own text.
 */
function findIgnoreReason(
  sourceFile: ts.SourceFile,
  clause: ts.CatchClause,
): string | undefined {
  const scope = ts.isTryStatement(clause.parent) ? clause.parent : clause;
  const fullText = scope.getFullText(sourceFile);
  const match = IGNORE_MARKER_PATTERN.exec(fullText);
  return match?.[1];
}

function firstNonEmptyLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "{" && line !== "}");
  return lines[0] ?? "{}";
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

export interface Finding {
  readonly relPath: string;
  readonly line: number;
  readonly evidence: string;
}

export interface ScanResult {
  readonly findings: readonly Finding[];
  readonly clauseCount: number;
  readonly compliantCount: number;
  readonly optedOutCount: number;
  readonly optedOutNotes: readonly string[];
}

/** Walks every file's catch clauses once, classifying each as opted out,
 * compliant, or a finding — independent of baseline/diff gating. */
export function scanForFindings(files: readonly ScannedFile[]): ScanResult {
  const findings: Finding[] = [];
  const optedOutNotes: string[] = [];
  let clauseCount = 0;
  let compliantCount = 0;
  let optedOutCount = 0;

  for (const { relPath, contents } of files) {
    const sourceFile = ts.createSourceFile(
      relPath,
      contents,
      ts.ScriptTarget.Latest,
      true,
      relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const bindings = findReportErrorBindings(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        clauseCount += 1;
        const line = lineOf(sourceFile, node);
        const bodyText = node.block.getText(sourceFile);
        const ignoreReason = findIgnoreReason(sourceFile, node);

        if (ignoreReason !== undefined) {
          optedOutCount += 1;
          optedOutNotes.push(
            `${relPath}:${line}: catch opted out (${ignoreReason})`,
          );
        } else if (
          callsReportError(node.block, bindings) ||
          containsThrow(node.block)
        ) {
          compliantCount += 1;
        } else {
          findings.push({
            relPath,
            line,
            evidence: firstNonEmptyLine(bodyText),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    findings,
    clauseCount,
    compliantCount,
    optedOutCount,
    optedOutNotes,
  };
}

function violationMessage(finding: Finding): string {
  return (
    `${finding.relPath}:${finding.line}: catch neither calls ` +
    `reportError(...) from @corbits/error-sink nor rethrows — body ` +
    `starts with "${finding.evidence}". Report it through reportError, ` +
    `rethrow it, or add a "report-error-ignore: <reason>" comment on ` +
    `the catch or in its body if this is a deliberate exception.`
  );
}

export function baselineKey(
  relPath: string,
  occurrence: number,
  evidence: string,
): string {
  return `${relPath}\t${occurrence}\t${evidence}`;
}

/**
 * Assigns each finding its 1-based occurrence among findings sharing the
 * same (relPath, evidence) pair, in scan order, and keys it — the stable
 * identity a baseline entry keys on, since raw line numbers drift as a
 * file is edited elsewhere.
 */
export function keyFindings(
  findings: readonly Finding[],
): Map<string, Finding> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, Finding>();
  for (const finding of findings) {
    const seenKey = `${finding.relPath} ${finding.evidence}`;
    const occurrence = (seen.get(seenKey) ?? 0) + 1;
    seen.set(seenKey, occurrence);
    keyed.set(
      baselineKey(finding.relPath, occurrence, finding.evidence),
      finding,
    );
  }
  return keyed;
}

export function parseBaseline(text: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0 || line.startsWith("#")) continue;
    keys.add(line);
  }
  return keys;
}

export function serializeBaseline(keys: Iterable<string>): string {
  return BASELINE_HEADER + [...keys].sort().join("\n") + "\n";
}

/** An inclusive range of line numbers (in the current, post-change file)
 * that a diff hunk added or left as context. */
export interface ChangedRange {
  readonly start: number;
  readonly end: number;
}

export interface AuditOptions {
  readonly baseline: ReadonlySet<string>;
  /**
   * Changed line ranges per repo-relative path, keyed to the current
   * (post-change) file's own line numbers. Undefined when no base ref is
   * available — the ratchet no-ops in that case, but new-vs-baseline
   * enforcement (and stale-entry detection) still runs.
   *
   * This is deliberately line-range, not whole-file: a change that edits
   * one function in a large file shouldn't be forced to also clean up
   * unrelated pre-existing debt elsewhere in that same file — including,
   * notably, this very check's own PR, whose only edit to a file with
   * baselined debt is adding a report-error-ignore comment nowhere near
   * it.
   */
  readonly changedLines?: ReadonlyMap<string, readonly ChangedRange[]>;
}

function isLineChanged(
  changedLines: AuditOptions["changedLines"],
  relPath: string,
  line: number,
): boolean {
  const ranges = changedLines?.get(relPath);
  if (ranges === undefined) return false;
  return ranges.some((range) => line >= range.start && line <= range.end);
}

export function auditReportError(
  files: readonly ScannedFile[],
  options: AuditOptions,
): CheckReport {
  const report = emptyReport();
  const scan = scanForFindings(files);
  const keyed = keyFindings(scan.findings);

  let newCount = 0;
  let baselinedCount = 0;
  for (const [key, finding] of keyed) {
    const inBaseline = options.baseline.has(key);
    if (!inBaseline) {
      newCount += 1;
      report.violations.push(violationMessage(finding));
      continue;
    }
    baselinedCount += 1;
    if (isLineChanged(options.changedLines, finding.relPath, finding.line)) {
      report.violations.push(
        `${violationMessage(finding)} This change's diff touches this ` +
          `catch, so its baselined report-error debt must be fixed or ` +
          `given its own report-error-ignore comment rather than left ` +
          `in the baseline.`,
      );
    }
  }

  const staleKeys = [...options.baseline].filter((key) => !keyed.has(key));
  for (const key of staleKeys) {
    report.violations.push(
      `${BASELINE_PATH}: stale entry "${key}" no longer matches a real ` +
        `finding — regenerate with "bun run scripts/checks/` +
        `report-error.ts --write-baseline" so the baseline only shrinks.`,
    );
  }

  report.notes.push(...scan.optedOutNotes);
  report.notes.push(
    `${scan.clauseCount} catch clause(s) scanned: ${scan.compliantCount} ` +
      `compliant, ${scan.optedOutCount} opted out, ${baselinedCount} ` +
      `baselined pre-existing, ${newCount} new finding(s), ` +
      `${staleKeys.length} stale baseline entrie(s)`,
  );
  return report;
}

function git(root: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const DIFF_FILE_PATTERN = /^\+\+\+ b\/(.+)$/;
const DIFF_HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a zero-context unified diff (`git diff --unified=0`) into the
 * changed line ranges of each file, in that file's post-change line
 * numbers — the same numbering `lineOf` uses when scanning the current
 * tree. A hunk that only deletes lines (`+c,0`) touches nothing in the
 * new file and is skipped.
 */
export function parseChangedRanges(
  diffText: string,
): Map<string, ChangedRange[]> {
  const ranges = new Map<string, ChangedRange[]>();
  let currentFile: string | undefined;
  for (const line of diffText.split("\n")) {
    const fileMatch = DIFF_FILE_PATTERN.exec(line);
    if (fileMatch?.[1] !== undefined) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = DIFF_HUNK_PATTERN.exec(line);
    if (hunkMatch === null || currentFile === undefined) continue;
    const start = Number(hunkMatch[1]);
    const count = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
    if (count === 0) continue;
    const list = ranges.get(currentFile) ?? [];
    list.push({ start, end: start + count - 1 });
    ranges.set(currentFile, list);
  }
  return ranges;
}

async function readFiles(root: string): Promise<ScannedFile[]> {
  const relPaths = await scanFiles(root, SCAN_DIRS);
  return Promise.all(
    relPaths.map(async (relPath) => ({
      relPath,
      contents: await Bun.file(path.join(root, relPath)).text(),
    })),
  );
}

async function writeBaseline(root: string): Promise<void> {
  const files = await readFiles(root);
  const scan = scanForFindings(files);
  const keyed = keyFindings(scan.findings);
  await Bun.write(
    path.join(root, BASELINE_PATH),
    serializeBaseline(keyed.keys()),
  );
  console.log(
    `check:report-error: wrote ${keyed.size} entrie(s) to ${BASELINE_PATH}`,
  );
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);

  if (args.includes("--write-baseline")) {
    await writeBaseline(root);
    return;
  }

  const files = await readFiles(root);

  const baselineFile = Bun.file(path.join(root, BASELINE_PATH));
  const baseline = (await baselineFile.exists())
    ? parseBaseline(await baselineFile.text())
    : new Set<string>();

  const baseRef = resolveBaseRef(root, process.env["CHECK_BASE_REF"]);
  const changedLines =
    baseRef === undefined
      ? undefined
      : parseChangedRanges(
          git(root, ["diff", "--unified=0", `${baseRef}...HEAD`]) ?? "",
        );

  const report = auditReportError(files, { baseline, changedLines });
  if (baseRef === undefined) {
    report.notes.push(
      "no base ref (no origin/main, no CHECK_BASE_REF); skipping the " +
        "touched-line ratchet — CI supplies the base ref for the " +
        "authoritative run. New-vs-baseline enforcement still applies.",
    );
  }
  report.notes.push(
    `scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:report-error", report);
}

if (import.meta.main) await main();
