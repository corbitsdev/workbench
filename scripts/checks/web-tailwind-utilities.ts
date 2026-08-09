// check:web-utilities — app-authored Tailwind classes must land in the
// production CSS. apps/web used to import only react-ui's prebuilt
// stylesheet, so every utility react-ui itself did not use was dead CSS.
// This check builds the web app (when dist is missing or stale) and asserts
// a fixed set of known app/package utilities appear in the emitted CSS.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

/** Substrings that must appear in the built CSS. Escaped selectors are
 * written the way Tailwind emits them (e.g. `sm\:px-7`). */
const REQUIRED_UTILITIES = [
  "grid-cols-",
  "sm\\:px-7",
  "w-fit",
  "min-h-",
  "bg-\\[var\\(--chart-1\\)\\]",
  "bg-\\[var\\(--chart-2\\)\\]",
  "bg-\\[var\\(--chart-3\\)\\]",
  "bg-\\[var\\(--chart-4\\)\\]",
  "bg-\\[var\\(--chart-5\\)\\]",
  "bg-muted",
] as const;

function newestMtime(dir: string, extensions: readonly string[]): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // ignore unreadable files
      }
    }
  }
  return newest;
}

function findBuiltCss(distAssets: string): string | null {
  try {
    const file = readdirSync(distAssets).find((name) => name.endsWith(".css"));
    return file === undefined ? null : path.join(distAssets, file);
  } catch {
    return null;
  }
}

async function ensureWebBuild(
  root: string,
  report: CheckReport,
): Promise<void> {
  const webDir = path.join(root, "apps/web");
  const distAssets = path.join(webDir, "dist/assets");
  const cssPath = findBuiltCss(distAssets);
  const sourceNewest = Math.max(
    newestMtime(path.join(webDir, "src"), [".tsx", ".ts", ".css"]),
    newestMtime(path.join(root, "packages/artifact-ui/src"), [".tsx", ".ts"]),
  );
  const cssMtime =
    cssPath === null
      ? 0
      : (() => {
          try {
            return statSync(cssPath).mtimeMs;
          } catch {
            return 0;
          }
        })();

  if (cssPath !== null && cssMtime >= sourceNewest) {
    report.notes.push(
      `reusing existing build at ${path.relative(root, cssPath)}`,
    );
    return;
  }

  report.notes.push("building @workbench/web for CSS inspection");
  const proc = Bun.spawn(
    ["bun", "run", "--filter", "@workbench/web", "build"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text();
    report.violations.push(`web build failed (exit ${exit}): ${stderr.trim()}`);
  }
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const report = emptyReport();
  await ensureWebBuild(root, report);
  if (report.violations.length > 0) {
    reportAndExit("check:web-utilities", report);
  }

  const cssPath = findBuiltCss(path.join(root, "apps/web/dist/assets"));
  if (cssPath === null) {
    report.violations.push(
      "no CSS asset under apps/web/dist/assets after build",
    );
    reportAndExit("check:web-utilities", report);
  }

  const css = readFileSync(cssPath, "utf8");
  for (const utility of REQUIRED_UTILITIES) {
    if (!css.includes(utility)) {
      report.violations.push(
        `built CSS missing utility substring ${JSON.stringify(utility)} (file ${path.relative(root, cssPath)})`,
      );
    }
  }
  if (report.violations.length === 0) {
    report.notes.push(
      `all ${REQUIRED_UTILITIES.length} required utilities present in ${path.relative(root, cssPath)}`,
    );
  }
  reportAndExit("check:web-utilities", report);
}

await main();
