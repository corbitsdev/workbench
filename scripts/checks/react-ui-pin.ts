// check:react-ui-pin — every consumer of `@corbits/react-ui` must pin the
// same commit.
//
// react-ui ships as a git dependency, so a "version" is a SHA in each
// consumer's package.json and there is nothing resolving them to a common
// one. Ten packages once sat on four different SHAs, which meant up to four
// copies of the library loaded in a single page and two packages could
// render different versions of the same component side by side — invisible
// until the day they disagree, and impossible to reason about from any one
// manifest. It also hides duplication: "we already have that upstream" is
// not a checkable statement when upstream means four different trees.
//
// The invariant is therefore one pin, repo-wide. Bumping react-ui is a
// lockstep edit across every consumer, and this check is what makes a
// partial bump fail loudly instead of silently forking the library.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const REACT_UI = "@corbits/react-ui";

export interface PinnedManifest {
  readonly relPath: string;
  /** The dependency specifier verbatim, e.g. `github:corbitsdev/react-ui#<sha>`. */
  readonly pin: string;
}

/**
 * Compares pins verbatim rather than extracting and comparing the SHA: two
 * specifiers that name the same commit by different means still install
 * separately under bun's lockfile, so "same commit, different specifier" is
 * the very drift this exists to catch, not an exception to it.
 */
export function auditReactUiPins(
  manifests: readonly PinnedManifest[],
): CheckReport {
  const report = emptyReport();
  if (manifests.length === 0) {
    report.notes.push(`no ${REACT_UI} consumer found`);
    return report;
  }

  const byPin = new Map<string, string[]>();
  for (const manifest of manifests) {
    const current = byPin.get(manifest.pin);
    if (current === undefined) byPin.set(manifest.pin, [manifest.relPath]);
    else current.push(manifest.relPath);
  }

  if (byPin.size === 1) {
    const [pin] = [...byPin.keys()];
    report.notes.push(
      `${manifests.length} consumer(s) share one pin: ${pin ?? ""}`,
    );
    return report;
  }

  report.violations.push(
    `${REACT_UI} is pinned at ${byPin.size} different specifiers; every consumer must share one`,
  );
  for (const [pin, relPaths] of [...byPin.entries()].sort()) {
    for (const relPath of relPaths.sort()) {
      report.violations.push(`  ${relPath}: ${pin}`);
    }
  }
  return report;
}

async function scanPins(root: string): Promise<PinnedManifest[]> {
  const manifests: PinnedManifest[] = [];
  const glob = new Glob("{apps,packages}/*/package.json");
  for await (const relPath of glob.scan({ cwd: root, dot: false })) {
    if (relPath.includes("node_modules/")) continue;
    const parsed = (await Bun.file(path.join(root, relPath)).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pin =
      parsed.dependencies?.[REACT_UI] ?? parsed.devDependencies?.[REACT_UI];
    if (pin !== undefined) manifests.push({ relPath, pin });
  }
  return manifests;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  reportAndExit("check:react-ui-pin", auditReactUiPins(await scanPins(root)));
}

if (import.meta.main) await main();
