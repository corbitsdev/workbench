// The editable half of a text-kind artifact's canvas pane. Built on top of
// `ArtifactRenderer`'s read-only surface rather than replacing it:
// `ArtifactRenderer` still owns every other kind, and a viewer with no
// write access still renders through it read-only. This component only
// ever mounts for a "doc"-kind artifact once the host has already decided
// the viewer can edit — it never makes that call itself.
//
// This is a plain controlled textarea, debounced-saved through `onSave`
// (the host wires that to the artifacts HTTP route's PUT). Single-user
// editing only; no live co-viewer cursors, no shared doc, no awareness.
import { useEffect, useRef, useState } from "react";

import { formatSaveStateLine, type ArtifactSaveState } from "./save-state";

const SAVE_DEBOUNCE_MS = 1_000;

export interface ArtifactTextEditorProps {
  readonly content: string;
  readonly title: string;
  /** No write access: renders the text but ignores keystrokes. */
  readonly readOnly: boolean;
  readonly saveState: ArtifactSaveState;
  /** Fired at most once per `SAVE_DEBOUNCE_MS` of typing idle, with the
   * full current text — the host's one seam to the artifacts PUT route. */
  readonly onSave: (content: string) => void;
}

/**
 * The host must remount this component (`key={artifact.id}`) when the open
 * artifact changes — the same convention `ArtifactRenderer` doesn't need
 * because it's stateless, but this component's local `value` buffer is not:
 * without a remount, switching artifacts while one has unsaved keystrokes
 * would carry them onto the new artifact's content.
 */
export function ArtifactTextEditor({
  content,
  title,
  readOnly,
  saveState,
  onSave,
}: ArtifactTextEditorProps) {
  const [value, setValue] = useState(content);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  return (
    <div className="shell-artifact-text-editor">
      <textarea
        className="shell-artifact-text-editor-body"
        value={value}
        readOnly={readOnly}
        aria-label={title}
        aria-readonly={readOnly}
        onChange={(event) => {
          if (readOnly) return;
          const next = event.target.value;
          setValue(next);
          if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            onSave(next);
          }, SAVE_DEBOUNCE_MS);
        }}
      />
      <div className="shell-artifact-save-state" aria-live="polite">
        {formatSaveStateLine(saveState, Date.now())}
      </div>
    </div>
  );
}
