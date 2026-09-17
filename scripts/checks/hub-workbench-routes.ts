// Hub-zero T3 (CL-8114): the hub mounts no workbench-scoped GitHub-connect
// surface. `@corbits/connections` keeps owning the `createConnectGithubRoutes`
// factory (its own package tests still cover it) — what is gone is the hub
// composition root's `${TENANT_PREFIX}/workbenches` mount of it, whose
// `getTemplateSettings` / `persistSelectedRepos` / `onReviewingStarted` ports
// were the last hub readers of the `workbench_settings` row. GitHub
// connect/disconnect now goes through the native tenant-scoped
// `/api/tenants/:tenantId/connections/*` routes only; the room card's
// state/start-reviewing rebind is a connections follow-up (the card renders
// its existing no-port disabled framing until then).
//
// This check locks the done-when: no `createConnectGithubRoutes` reference
// and no bare `${TENANT_PREFIX}/workbenches` mount in `apps/hub/src`, the
// brief's `workbench-settings|/workbenches.*github|github.*workbench` rg
// empty over `apps/hub/src`, and `listWorkbenchSettings` surviving in
// `apps/hub` only inside the T4-owned scheduled-delivery seam
// (`scheduledDeliveryJoinDeps`), which reads the row for delivery — never
// for GitHub connect.
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

/** The T4-owned seam still allowed to read the settings row: scheduled
 * delivery resolving the workbench a run belongs to. Any
 * `listWorkbenchSettings` call site outside a file containing this marker
 * is a new workbench-settings reader the hub-zero cutover missed. */
const DELIVERY_SEAM_MARKER = "scheduledDeliveryJoinDeps";

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
    if (!file.contents.includes("listWorkbenchSettings")) continue;
    if (file.contents.includes(DELIVERY_SEAM_MARKER)) {
      report.notes.push(
        `${file.relPath}: listWorkbenchSettings survives inside the ` +
          "T4-owned scheduled-delivery seam only — documented, not a violation",
      );
      continue;
    }
    report.violations.push(
      `${file.relPath}: listWorkbenchSettings outside the T4-owned ` +
        "scheduled-delivery seam — a workbench-settings reader hub-zero missed",
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
