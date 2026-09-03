// check:routine-target-inference — CL-7364 deleted routine target
// inference from chat membership (`agents[0]?.definitionId` /
// `agents[0].definitionId`) and the retired `workflow.json` envelope
// path. This check keeps both deletions from quietly regrowing:
//
// - `apps/web` and `packages/chat-ui` may never re-derive a routine's
//   target from the first invited agent in a room — a person always
//   picks a target explicitly through `DefinitionTargetPicker` (see
//   docs/workflow-model.md, "Behavior to delete, not retain").
// - No non-vendor source may read or write a literal `workflow.json`
//   path, except `@corbits/workflows`'s `./source`'s own
//   `RetiredWorkflowEnvelopeError` message, which exists only to name
//   the retired path in order to reject it.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const TARGET_INFERENCE_SCAN_DIRS = ["apps/web", "packages/chat-ui"];
const WORKFLOW_JSON_SCAN_DIRS = ["apps", "packages", "workflows"];

const AGENTS_ZERO_DEFINITION_ID_PATTERN =
  /\bagents\[0\](?:\?\.|\.)\s*definitionId\b/g;
const WORKFLOW_JSON_LITERAL_PATTERN = /(["'`])workflow\.json\1/g;

const WORKFLOW_JSON_ALLOWED_FILE = "packages/workflows/src/source.ts";

export async function scanFiles(
  root: string,
  dirs: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    const glob = new Glob(`${dir}/**/*.{ts,tsx}`);
    for await (const file of glob.scan({ cwd: root, dot: false })) {
      if (file.includes("node_modules/")) continue;
      if (file.includes("/dist/") || file.startsWith("dist/")) continue;
      if (file.includes("/vendor/") || file.startsWith("vendor/")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      files.push(file);
    }
  }
  return files;
}

export function auditRoutineTargetInference(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    const matches = [...contents.matchAll(AGENTS_ZERO_DEFINITION_ID_PATTERN)];
    if (matches.length === 0) continue;
    report.violations.push(
      `${relPath}: reads agents[0]'s definitionId. A routine's target is ` +
        `never inferred from the first invited agent — a person picks it ` +
        `explicitly through DefinitionTargetPicker (see ` +
        `docs/workflow-model.md, "Behavior to delete, not retain").`,
    );
  }
  return report;
}

/** Drops `//` line comments and `*`-prefixed JSDoc continuation lines
 * before scanning — a comment or doc-string that mentions `workflow.json`
 * in backticks (documenting the retirement, say) is not a path a program
 * reads or writes, only a real string literal in code is. */
function stripCommentLines(contents: string): string {
  return contents
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        return "";
      }
      return line;
    })
    .join("\n");
}

export function auditWorkflowJsonLiteral(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    if (relPath === WORKFLOW_JSON_ALLOWED_FILE) continue;
    const code = stripCommentLines(contents);
    const matches = [...code.matchAll(WORKFLOW_JSON_LITERAL_PATTERN)];
    if (matches.length === 0) continue;
    report.violations.push(
      `${relPath}: names the retired "workflow.json" envelope path. ` +
        `workflow.json is retired — no path may read or write it; the only ` +
        `remaining mention is ${WORKFLOW_JSON_ALLOWED_FILE}'s ` +
        `RetiredWorkflowEnvelopeError, which exists to reject it.`,
    );
  }
  return report;
}

async function readAll(
  root: string,
  relPaths: readonly string[],
): Promise<{ relPath: string; contents: string }[]> {
  return Promise.all(
    relPaths.map(async (relPath) => ({
      relPath,
      contents: await Bun.file(path.join(root, relPath)).text(),
    })),
  );
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);

  const targetInferenceFiles = await readAll(
    root,
    await scanFiles(root, TARGET_INFERENCE_SCAN_DIRS),
  );
  const workflowJsonFiles = await readAll(
    root,
    await scanFiles(root, WORKFLOW_JSON_SCAN_DIRS),
  );

  const report = emptyReport();
  const targetReport = auditRoutineTargetInference(targetInferenceFiles);
  const workflowJsonReport = auditWorkflowJsonLiteral(workflowJsonFiles);
  report.violations.push(
    ...targetReport.violations,
    ...workflowJsonReport.violations,
  );
  report.notes.push(
    `scanned ${targetInferenceFiles.length} file(s) under ${TARGET_INFERENCE_SCAN_DIRS.join(", ")} for agents[0] target inference`,
    `scanned ${workflowJsonFiles.length} file(s) under ${WORKFLOW_JSON_SCAN_DIRS.join(", ")} for the retired workflow.json path`,
  );
  reportAndExit("check:routine-target-inference", report);
}

if (import.meta.main) await main();
