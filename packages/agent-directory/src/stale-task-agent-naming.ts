// Recognizes an agent definition minted by the now-deleted task-planner
// primitive. Nothing mints this prefix anymore, but a tenant seeded before
// that deletion can still carry lingering rows a picker must exclude.
const PLANNER_CREATED_HANDLE_PREFIX = "myra-task-";

export function isPlannerCreatedDefinitionName(definitionName: string): boolean {
  return definitionName.startsWith(PLANNER_CREATED_HANDLE_PREFIX);
}
