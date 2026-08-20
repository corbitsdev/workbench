// The naming contract for agent definitions Myra creates on the fly
// (CL-6051's `{create}` branch), mirroring `@corbits/chat`'s
// `workbench-host-naming.ts` in shape and doc style: one function that
// mints a compliant handle deterministically, one predicate that
// recognizes it later. A planner-created agent exists for exactly one
// task — it must never clutter a picker meant for agents a person
// deliberately keeps around, but it must remain fully launchable (see
// `isPlannerCreatedDefinitionName`'s own doc for why this predicate is
// never wired into a taskability gate).

/** Every planner-created handle starts with this prefix, so it reads
 * as what it is wherever a raw definition name surfaces (logs, the
 * task record's "why this agent?" link) without needing a side table. */
const PLANNER_CREATED_HANDLE_PREFIX = "myra-task-";

/**
 * Slugifies `name` into agent-directory's `HANDLE_PATTERN`
 * (`^[a-z0-9]+(-[a-z0-9]+)*$`, see `@corbits/agent-directory`'s
 * `validation.ts`), prefixes it, and appends a short random suffix so
 * two agents Myra creates from the same-sounding outcome never collide
 * — a planner-created handle is never shown to a person to retype, so
 * collision recovery has no UI to serve; a random suffix makes
 * collision practically impossible instead of retrying a 409.
 */
export function plannerCreatedDefinitionHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const maxSlugLength =
    63 - PLANNER_CREATED_HANDLE_PREFIX.length - 1 - suffix.length;
  const truncated = (slug === "" ? "agent" : slug)
    .slice(0, Math.max(maxSlugLength, 1))
    .replace(/-+$/g, "");
  return `${PLANNER_CREATED_HANDLE_PREFIX}${truncated === "" ? "agent" : truncated}-${suffix}`;
}

/**
 * Whether a definition name belongs to an agent Myra created on the
 * fly for one task. Exclude this from LISTING/PICKER surfaces only —
 * NEVER from the taskability/launchability gate
 * (`isConversationalAgentDefinition`/`TaskLauncherDeps.isTaskableDefinition`):
 * `spawnFromTaskSpec`'s `{create}` branch calls `launchTask` against
 * the definition it just created, and that call would throw
 * `TaskDefinitionNotTaskableError` immediately if this predicate were
 * folded into the taskability gate itself. Compose it instead with the
 * base predicate at each listing call site (see
 * `apps/hub/src/index.ts`'s `isPickerListableDefinition`).
 */
export function isPlannerCreatedDefinitionName(
  definitionName: string,
): boolean {
  return definitionName.startsWith(PLANNER_CREATED_HANDLE_PREFIX);
}
