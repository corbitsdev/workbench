// The canvas artifact pane's save-state line — never a fake autosave claim.
// "Saved · v12" is only ever rendered once the artifact's PUT route has
// actually answered with that version (CL-8189: single-user editing, no
// co-edit presence); until then the host renders "Saving…" or "Unsaved
// changes" honestly instead of guessing that a debounced write already
// landed.

export type ArtifactSaveState =
  | { readonly kind: "read-only" }
  | { readonly kind: "saving" }
  | {
      readonly kind: "saved";
      readonly version: number;
      readonly savedAt: number;
    }
  | { readonly kind: "unsaved" };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A relative-time label for a confirmed save, honest about its own
 * precision: past a day old it falls back to a bare "Saved" rather than
 * printing a day count nobody asked for. */
export function formatSavedLabel(savedAt: number, now: number): string {
  const deltaMs = Math.max(0, now - savedAt);
  if (deltaMs < MINUTE_MS) return "Saved just now";
  if (deltaMs < HOUR_MS) return `Saved ${Math.floor(deltaMs / MINUTE_MS)}m ago`;
  if (deltaMs < DAY_MS) return `Saved ${Math.floor(deltaMs / HOUR_MS)}h ago`;
  return "Saved";
}

/** The one line the canvas artifact pane renders under an editable text
 * artifact — empty for a read-only viewer, since there is nothing to
 * report about a save state they can't affect. */
export function formatSaveStateLine(state: ArtifactSaveState, now: number): string {
  switch (state.kind) {
    case "read-only":
      return "";
    case "saving":
      return "Saving…";
    case "saved":
      return `${formatSavedLabel(state.savedAt, now)} · v${state.version}`;
    case "unsaved":
      return "Unsaved changes";
  }
}
