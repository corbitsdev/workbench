// check:tailwind-source — every package whose stylesheet apps/web/src/app.css
// imports must also be scanned by apps/web/src/tailwind.css's @source list.
// A workspace UI package is source-only: its .tsx files carry Tailwind
// utility classes directly, and nothing but @source scanning generates the
// CSS for them (see tailwind.css's own header comment). Importing a
// package's prebuilt styles.css says nothing about whether its component
// tree also leans on Tailwind utilities — CL-6490 found @corbits/plugins-ui
// imported without a matching @source entry, so `data-[state=connected]:
// bg-success`, `min-h-16`, and `[&>*:last-child]:border-b-0` never made it
// into the built CSS. Nothing errored: the classes just silently did not
// exist, and the failure only showed up as broken layout in production.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const APP_CSS = "apps/web/src/app.css";
const TAILWIND_CSS = "apps/web/src/tailwind.css";

const IMPORT_PATTERN = /@import\s+"@corbits\/([a-z0-9-]+)\/styles\.css";/g;
const SOURCE_PATTERN =
  /@source\s+"\.\.\/\.\.\/\.\.\/packages\/([a-z0-9-]+)\/src";/g;

/** Package names behind every `@corbits/<name>/styles.css` import. */
export function importedStylesheetPackages(css: string): string[] {
  return [...css.matchAll(IMPORT_PATTERN)].map((match) => match[1] as string);
}

/** Package names behind every `@source ".../packages/<name>/src"` entry. */
export function sourcedPackages(css: string): string[] {
  return [...css.matchAll(SOURCE_PATTERN)].map((match) => match[1] as string);
}

/**
 * A package whose stylesheet app.css imports must appear in tailwind.css's
 * @source list — a package sourced without being imported (e.g. artifact-ui,
 * which has no prebuilt stylesheet of its own) is not a violation, since
 * @source scanning is the only thing that package ever relies on.
 */
export function auditTailwindSource(
  imported: readonly string[],
  sourced: readonly string[],
): CheckReport {
  const report = emptyReport();
  const sourcedSet = new Set(sourced);
  for (const name of imported) {
    if (sourcedSet.has(name)) continue;
    report.violations.push(
      `${TAILWIND_CSS}: no @source entry for @corbits/${name} even though ` +
        `${APP_CSS} imports its styles.css — that package's component tree ` +
        `is scanned for nothing, so any Tailwind utility class it uses ` +
        `silently does not exist in the built CSS instead of erroring. ` +
        `Add \`@source "../../../packages/${name}/src";\` to ${TAILWIND_CSS}.`,
    );
  }
  return report;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const appCss = readFileSync(path.join(root, APP_CSS), "utf8");
  const tailwindCss = readFileSync(path.join(root, TAILWIND_CSS), "utf8");
  const imported = importedStylesheetPackages(appCss);
  const sourced = sourcedPackages(tailwindCss);
  const report = auditTailwindSource(imported, sourced);
  report.notes.push(
    `${imported.length} stylesheet import(s) in ${APP_CSS}, ` +
      `${sourced.length} @source entr(y/ies) in ${TAILWIND_CSS}`,
  );
  reportAndExit("check:tailwind-source", report);
}

if (import.meta.main) await main();
