import type { ToolPackagePin } from "@intx/types/tool-packages";

/**
 * The tool packages this deployment pins. Firm memory
 * (`memory_add`/`memory_search`/`memory_list`) is no longer one of
 * these: `@corbits/memory` is a normal published dependency, not a
 * workspace tool package the pin/registry resolver can name, so its
 * tool factories are attached directly on `toolFactories` in
 * `./index.ts` instead. `@corbits/capability-tools` lets Myra
 * self-service a missing tool, skill, or model; the manager-tools
 * bundles give Myra real workbench-management capability — a specialist
 * agent she can create (each gets their own chat) and skill capture —
 * each a thin wrapper over an existing platform primitive (see each
 * package's own file-header comment for which one).
 * `@corbits/interaction-tools` gives her the ask-user card;
 * `@corbits/manus-tools` is pinned so Manus tools exist when the tenant
 * has connected Manus (launch folds the binding only then — the pin
 * itself does not require a credential). `@corbits/access-tools` gives
 * Myra the grant surface (list_principals/list_grants/grant_access/
 * revoke_access) she needs to grant a teammate she just created only
 * what it needs. No `@intx/tools-posix`: Myra never gets raw filesystem
 * access.
 */
export const ASSISTANT_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/memory", version: "0.1.2" },
  { name: "@corbits/capability-tools", version: "0.0.7" },
  { name: "@corbits/agent-directory-tools", version: "0.0.7" },
  { name: "@corbits/catalog-tools", version: "0.1.1" },
  { name: "@corbits/skills-tools", version: "0.0.9" },
  { name: "@corbits/interaction-tools", version: "0.0.11" },
  { name: "@corbits/manus-tools", version: "0.0.12" },
  { name: "@corbits/workflow-authoring-tools", version: "0.0.8" },
  { name: "@corbits/access-tools", version: "0.0.6" },
];
