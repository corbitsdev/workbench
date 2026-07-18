// Fail-fast guard: every bun invocation in this repo MUST run with the
// `intx-src` resolve condition active (via `BUN_OPTIONS=--conditions=intx-src`,
// which every root/member script sets, or a literal `--conditions=intx-src`).
// Without it, `@intx/*` imports resolve against each package's `default` export
// (the unbuilt `dist/` in this source-only interchange checkout) instead of its
// `intx-src` source export, so the whole graph fails to resolve. bunfig.toml
// cannot set the condition globally (verified: only the CLI flag / BUN_OPTIONS
// applies), so a script that skips the wiring — or a hand-run bun command —
// hits a cryptic module-resolution error deep in the graph. This preflight
// turns that into one clear message at the top.
//
// Detection: resolve a known `@intx/*` package from a package that depends on
// it. With the condition active it resolves to interchange's `src/*.ts` source
// export; without it, the `default` export points at an unbuilt `dist/*.js`
// path and resolution throws. Bun.resolveSync honors the active resolve
// conditions, so this reflects exactly how `@intx/*` imports bind at runtime.

import { resolve } from "node:path";

const PROBE = "@intx/log";
// `@intx/*` is not hoisted to the repo-root node_modules; it is symlinked into
// each member that declares it. Resolve from a stable, always-present member
// (`apps/hub` depends heavily on `@intx/*`).
const RESOLVE_BASE = resolve(import.meta.dir, "..", "apps", "hub");

function bail(detail: string): never {
  console.error(
    [
      `preflight-intx-src: the "intx-src" resolve condition is NOT active (${detail}).`,
      `Every bun invocation in this repo needs it — @intx/* imports resolve to`,
      `interchange source only under this condition.`,
      ``,
      `Fix: run via a repo script (e.g. \`bun run test\`, \`bun run typecheck\`),`,
      `or set \`BUN_OPTIONS=--conditions=intx-src\` (or pass \`--conditions=intx-src\`)`,
      `before your bun command. If it persists, run \`bun install\` in this worktree.`,
    ].join("\n"),
  );
  process.exit(1);
}

let resolved: string;
try {
  resolved = Bun.resolveSync(PROBE, RESOLVE_BASE);
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  bail(`resolving ${PROBE} threw: ${reason}`);
}

// The `intx-src` export points at `.../src/<entry>.ts`; the `default` export
// points at `.../dist/<entry>.js`. A source `.ts` path is proof the condition
// is active.
if (!resolved.endsWith(".ts")) {
  bail(`${PROBE} resolved to ${resolved}, not its intx-src source export`);
}
