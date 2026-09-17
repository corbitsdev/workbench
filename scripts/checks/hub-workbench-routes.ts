// Hub-zero T3 (CL-8114) deleted the hub's workbench-scoped GitHub-connect
// mount; hub-zero T4 (CL-8126) cut the scheduled delivery join and the last
// `@workbench/templates` import. `@corbits/connections` keeps owning the
// `createConnectGithubRoutes` factory (its own package tests still cover
// it). GitHub connect/disconnect goes through the native tenant-scoped
// `/api/tenants/:tenantId/connections/*` routes only; the room card's
// state/start-reviewing rebind is a connections follow-up (the card renders
// its existing no-port disabled framing until then).
//
// This check locks both done-whens: no `createConnectGithubRoutes`
// reference and no bare `${TENANT_PREFIX}/workbenches` mount in
// `apps/hub/src`, the brief's `workbench-settings|/workbenches.*github|
// github.*workbench` rg empty over `apps/hub/src`, no `@workbench/templates`
// import anywhere in `apps/hub/src`, and no `listWorkbenchSettings` at all.
//
// Get/update variants (the T3 critic note): `getWorkbenchSettings` survives
// exactly once, inside `createCommandRoutes`' membership check — the
// T5-owned command guard a file carries the `COMMAND_GUARD_MARKER` for.
// `updateWorkbenchSettings` has no such exception. Any get/update call site
// outside a marker-carrying file is a settings-row reader the cutover
// missed. List-only was never an option: the surviving call site is a get,
// and the check treats each variant on its own terms.
import { readFileSync } from "node:fs";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

export type SourceFile = {
  readonly relPath: string;
  readonly contents: string;
};

/** The T5-owned command guard allowed to hold the surviving get-variant
 * read: `createCommandRoutes`' membership check. Any settings-row get/update
 * call site outside a file containing this marker is a reader the hub-zero
 * cutover missed. */
const COMMAND_GUARD_MARKER = "workbenchBelongsToTenant";

/** The brief's done-when rg, per line, case-insensitive. */
const DONE_WHEN_PATTERN =
  /workbench-settings|\/workbenches.*github|github.*workbench/i;

export function auditHubWorkbenchRoutes(
  files: readonly SourceFile[],
): CheckReport {
  const report = emptyReport();
  for (const file of files) {
    if (file.relPath !== "apps/hub/src/index.ts") continue;
    if (file.contents.includes("createConnectGithubRoutes")) {
      report.violations.push(
        `${file.relPath}: still references createConnectGithubRoutes — ` +
          "the hub's /workbenches GitHub-connect mount must be deleted " +
          "(connect/disconnect is native /connections/* now)",
      );
    }
    if (file.contents.includes("${TENANT_PREFIX}/workbenches`")) {
      report.violations.push(
        `${file.relPath}: still mounts \`\${TENANT_PREFIX}/workbenches\` — ` +
          "the workbench-scoped GitHub-connect mount must be deleted",
      );
    }
  }
  for (const file of files) {
    let offset = 0;
    for (const line of file.contents.split("\n")) {
      const lineNumber = file.contents.slice(0, offset).split("\n").length;
      offset += line.length + 1;
      if (DONE_WHEN_PATTERN.test(line)) {
        report.violations.push(
          `${file.relPath}:${lineNumber}: ` +
            `matches the hub-zero done-when rg: ${line.trim()}`,
        );
      }
    }
  }
  for (const file of files) {
    if (file.contents.includes("@workbench/templates")) {
      report.violations.push(
        `${file.relPath}: still imports @workbench/templates — ` +
          "the hub's connector surface is native now " +
          "(./native-connector-registry.ts); the legacy dep must stay deleted",
      );
    }
  }
  for (const file of files) {
    if (!file.contents.includes("listWorkbenchSettings")) continue;
    report.violations.push(
      `${file.relPath}: listWorkbenchSettings survives — ` +
        "T4 cut the scheduled-delivery seam that owned the only list read",
    );
  }
  for (const file of files) {
    const readsSettingsRow =
      file.contents.includes("getWorkbenchSettings") ||
      file.contents.includes("updateWorkbenchSettings");
    if (!readsSettingsRow) continue;
    if (file.contents.includes(COMMAND_GUARD_MARKER)) {
      report.notes.push(
        `${file.relPath}: a settings-row get/update read survives inside ` +
          "the T5-owned command guard only — documented, not a violation",
      );
      continue;
    }
    report.violations.push(
      `${file.relPath}: a settings-row get/update read outside the ` +
        "T5-owned command guard — a workbench-settings reader hub-zero missed",
    );
  }
  return report;
}

async function main(): Promise<never> {
  const root = rootFromArgs(process.argv);
  const files: SourceFile[] = [];
  for (const dir of ["apps/hub/src"]) {
    const glob = new Bun.Glob(`${dir}/**/*.{ts,tsx}`);
    for await (const relPath of glob.scan({ cwd: root, dot: false })) {
      if (relPath.includes("node_modules")) continue;
      files.push({
        relPath,
        contents: readFileSync(`${root}/${relPath}`, "utf8"),
      });
    }
  }
  reportAndExit("check:hub-workbench-routes", auditHubWorkbenchRoutes(files));
}

if (import.meta.main) await main();
