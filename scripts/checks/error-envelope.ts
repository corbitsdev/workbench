// check:error-envelope — a structural invariant: hub routes answer a
// failure with `@corbits/error-sink`'s `makeErrorEnvelope` (`code`,
// `userMessage`, `refId`). A locally-defined `{ error: { code, message } }`
// factory is a second envelope, and a second envelope is how `refId`
// support silently goes missing. This check greps for those factories —
// never for a comment or an arktype parser that happens to be named
// `ErrorEnvelope`.
//
// Documented exceptions live in ALLOWLIST below. Each entry is an
// explicit ruling that the named file may keep a helper because it
// already wraps the canonical `makeErrorEnvelope` (onboarding,
// connections, the hub's own template routes) or *is* the canonical
// helper (error-sink).
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "workflows"];

const ALLOWLIST = new Set<string>([
  "packages/error-sink/src/error-envelope.ts",
  "packages/onboarding/src/routes.ts",
  "packages/connections/src/connect-github-routes.ts",
  "apps/hub/src/templates/template-block-routes.ts",
]);

// Arrow: `const ErrorEnvelope = (code: string, message: string) => ({
//   error: { code, message },
// });`
// Function: `function errorEnvelope(code: string, message: string) {
//   return { error: { code, message } };
// }`
const ARROW_FACTORY =
  /(?:export\s+)?(?:const|let|var)\s+(ErrorEnvelope|errorEnvelope)\s*=\s*\(\s*code(?:\s*:\s*string)?\s*,\s*message(?:\s*:\s*string)?\s*\)\s*=>\s*\(?\s*\{\s*error:\s*\{\s*code\s*,\s*message\s*\}\s*,?\s*\}\s*\)?/s;
const FUNCTION_FACTORY =
  /(?:export\s+)?function\s+(ErrorEnvelope|errorEnvelope)\s*\(\s*code(?:\s*:\s*string)?\s*,\s*message(?:\s*:\s*string)?\s*\)\s*\{\s*return\s*\{\s*error:\s*\{\s*code\s*,\s*message\s*\}\s*,?\s*\}\s*;?\s*\}/s;

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
      if (file.includes(".test.") || file.includes("/test/")) continue;
      files.push(file);
    }
  }
  return files;
}

export function auditLocalErrorEnvelopeFactories(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    if (ALLOWLIST.has(relPath)) {
      report.notes.push(
        `${relPath}: allowlisted (canonical makeErrorEnvelope helper)`,
      );
      continue;
    }
    const arrow = ARROW_FACTORY.test(contents);
    const fn = FUNCTION_FACTORY.test(contents);
    if (!arrow && !fn) continue;
    report.violations.push(
      `${relPath}: defines a local { error: { code, message } } factory. ` +
        `Hub routes must use makeErrorEnvelope from @corbits/error-sink ` +
        `so every failure carries code, userMessage, and refId.`,
    );
  }
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
  const report = auditLocalErrorEnvelopeFactories(files);
  report.notes.push(
    `scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:error-envelope", report);
}

if (import.meta.main) await main();
