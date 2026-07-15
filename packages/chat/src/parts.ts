/**
 * Re-export of the parts-lift adapter, which now lives in
 * `@workbench/agent-core` (see `src/types.ts` for why). Kept here so
 * `@workbench/chat/parts` keeps resolving for existing web/renderer imports.
 */
export { liftToParts, toolPartToCall } from "@workbench/agent-core/parts";
