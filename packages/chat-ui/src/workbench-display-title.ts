import { CHAT_STRINGS } from "./strings";

/**
 * `POST /workbenches` titles an untitled mint with its own generated id
 * (`generateId("workflowRun")` -> `run_<32 hex>`; older workbenches carry
 * `generateId("instance")` -> `ins_<32 hex>`) rather than leaving the title
 * empty — see `packages/chat/src/routes.ts`'s `name: chatTitle ?? workbenchId`.
 * That wire id must never reach the UI, so every place a workbench title
 * renders routes through this one check instead of re-deriving it.
 */
const RUN_ID_SHAPE = /^(?:run|ins)_[0-9a-f]{32}$/;

/**
 * Renders `title` for display, replacing it with "New workbench" when it is
 * the row's own id or otherwise shaped like a generated run/instance id.
 * Leaves any other title — including an empty one — untouched, so callers
 * keep applying their own empty-title fallback on top of this.
 */
export function displayWorkbenchTitle(title: string, id: string): string {
  return title === id || RUN_ID_SHAPE.test(title)
    ? CHAT_STRINGS.newWorkbenchTitle
    : title;
}
