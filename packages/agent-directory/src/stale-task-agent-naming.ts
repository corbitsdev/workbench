// Recognizes an agent definition minted by the now-deleted tasks
// primitive's planner `{create}` branch (CL-6051), each of which
// existed for exactly one task. The minting side (what used to be
// `@corbits/task-planner`'s `plannerCreatedDefinitionHandle`) is gone
// along with that primitive — nothing creates a definition with this
// prefix anymore — but a tenant seeded before that deletion can still
// carry lingering rows, and any picker meant for agents a person
// deliberately keeps around must keep excluding them.
const PLANNER_CREATED_HANDLE_PREFIX = "myra-task-";

export function isPlannerCreatedDefinitionName(
  definitionName: string,
): boolean {
  return definitionName.startsWith(PLANNER_CREATED_HANDLE_PREFIX);
}
