import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolFactoryManifest } from "./schema";

// Every committed, deployed workflow definition declares its `action` steps'
// tools as a literal `<factoryId>:<bareName>` handler string (CL-4540 dropped
// the `@workbench/agents` build-time `canonicalizeStepToolName` lookup from
// workflow packages, in favor of workflows holding no dependency on
// monorepo-generated data). Losing that lookup also loses its build-time
// guarantee that a handler string actually names a real tool, so this module
// re-adds the check OUTSIDE the workflow packages: walk every committed
// workflow def, collect every `action` step's `handler` string, and assert it
// resolves against the committed tool manifest. A typo'd or manifest-drifted
// handler string fails this repo-level test instead of silently deploying a
// step nothing can dispatch.

// Bare, unprefixed handler names the sidecar's local (non-package) mail
// runner serves directly (`@intx/tools-mail`'s `TOOL_DEFINITIONS`) — these
// carry no factory id and never appear in the tool manifest. Hand-maintained
// mirror, matching `@workbench/agent-core`'s `LOCAL_RUNNER_TOOL_NAMES` (which
// this package cannot import without a dependency cycle — `agent-core`
// depends on `@workbench/tool-manifest`, not the reverse). A divergence test
// (`apps/hub/src/lib/local-runner-tool-names.test.ts`) already guards
// agent-core's copy against `@intx/tools-mail` drift; this set only needs to
// stay in lockstep with that one.
const LOCAL_RUNNER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mail_send",
  "mail_reply",
  "mail_search",
  "mail_read",
  "mail_wait",
]);

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Directory of committed serialized workflow defs (`apps/hub/generated/workflow-defs`). */
export function committedWorkflowDefsDir(): string {
  return join(repoRoot(), "apps/hub/generated/workflow-defs");
}

/** Every `<kind>.json` file's parsed content under the committed workflow-defs dir. */
export function loadCommittedWorkflowDefs(): Record<string, unknown>[] {
  const dir = committedWorkflowDefsDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
          string,
          unknown
        >,
    );
}

// Recursively collect every string value found under an object key named
// `handler` — the field `action` steps carry their tool reference on. Walking
// generically (rather than keying off `kind: "action"`) is deliberately
// tolerant of definition shape changes; a `handler` field appearing anywhere
// in a workflow def is, by construction, a tool reference that must resolve.
function collectHandlerStrings(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectHandlerStrings(item, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "handler" && typeof child === "string") {
      out.add(child);
      continue;
    }
    collectHandlerStrings(child, out);
  }
}

/** Every distinct `action`-step handler string declared across all committed workflow defs. */
export function collectAllWorkflowHandlers(
  defs: readonly Record<string, unknown>[],
): Set<string> {
  const out = new Set<string>();
  for (const def of defs) collectHandlerStrings(def, out);
  return out;
}

/**
 * Assert every handler string names a real `<factoryId>:<bareName>` pair in
 * the committed tool manifest. Throws with every unresolved handler listed
 * (not just the first) so a build failure shows the full blast radius.
 */
export function assertHandlersResolveToTools(
  handlers: ReadonlySet<string>,
  factories: readonly ToolFactoryManifest[],
): void {
  const knownPairs = new Set<string>();
  for (const factory of factories) {
    for (const bareName of factory.bareToolNames) {
      knownPairs.add(`${factory.factoryId}:${bareName}`);
    }
  }
  const unresolved = [...handlers]
    .filter(
      (handler) =>
        !knownPairs.has(handler) && !LOCAL_RUNNER_TOOL_NAMES.has(handler),
    )
    .sort();
  if (unresolved.length > 0) {
    throw new Error(
      `Workflow def handler(s) do not resolve to a real tool in the committed ` +
        `tool manifest — typo, retired tool, or manifest drift (regenerate via ` +
        `\`bun run build:tool-manifests\` if this is a real, newly-added tool): ` +
        unresolved.join(", "),
    );
  }
}
