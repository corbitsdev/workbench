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
// anything else is a violation. Matching the import binding rather than
// the bare name `reportError` means an unrelated local function that
// happens to share the name is still flagged, and an aliased import
// (`import { reportError as report }`) is still recognized.
//
// This is still text-level triage, not control-flow analysis: a catch
// that calls a helper which calls reportError three frames down will
// false-positive, and only `try { } catch { }` statements are walked — a
// bare `.catch(...)` promise handler is out of scope until there's real
// evidence it's worth the extra surface.
//
// Deliberate exceptions get a narrow, greppable, justified opt-out: a
// comment containing `report-error-ignore:` followed by a reason, placed
// on the line the `catch` itself starts on or anywhere inside its body.
// There is no blanket per-file allowlist — every exception states its own
// reason next to the code it excuses.
import { Glob } from "bun";
import path from "node:path";
import ts from "typescript";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "workflows"];
const IGNORE_MARKER_PATTERN = /report-error-ignore:\s*(\S.*)/;
const ERROR_SINK_MODULE = "@corbits/error-sink";

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

export function auditReportError(files: readonly ScannedFile[]): CheckReport {
  const report = emptyReport();
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
          report.notes.push(
            `${relPath}:${line}: catch opted out (${ignoreReason})`,
          );
        } else if (
          callsReportError(node.block, bindings) ||
          containsThrow(node.block)
        ) {
          compliantCount += 1;
        } else {
          const evidence = firstNonEmptyLine(bodyText);
          report.violations.push(
            `${relPath}:${line}: catch neither calls reportError(...) ` +
              `from @corbits/error-sink nor rethrows — body starts with ` +
              `"${evidence}". Report it through reportError, rethrow it, ` +
              `or add a "report-error-ignore: <reason>" comment on the ` +
              `catch or in its body if this is a deliberate exception.`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  report.notes.push(
    `${clauseCount} catch clause(s) scanned: ${compliantCount} compliant, ` +
      `${optedOutCount} opted out, ${report.violations.length} violation(s)`,
  );
  return report;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);
  const relPaths = await scanFiles(root, SCAN_DIRS);
  const files = await Promise.all(
    relPaths.map(async (relPath) => ({
      relPath,
      contents: await Bun.file(path.join(root, relPath)).text(),
    })),
  );
  const report = auditReportError(files);
  report.notes.push(
    `scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:report-error", report);
}

if (import.meta.main) await main();
