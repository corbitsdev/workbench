// Zero imports so config.ts can read a budget without pulling in playwright-core.
//
// OPERATION_BUDGET_MS is the ceiling on a whole tool call so a hung connect or
// close can't wedge the agent turn. Invariant (enforced by a test):
// CONNECT < OPERATION and ACTION <= OPERATION.
export const OPERATION_BUDGET_MS = 18_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const ACTION_TIMEOUT_MS = 9_000;
