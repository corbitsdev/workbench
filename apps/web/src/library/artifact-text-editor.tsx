// Only mounts once the host has already decided the viewer can edit — it
// never makes that call itself. Single-user only: no co-viewer cursors,
// no shared doc, no awareness.
import { useRef, useState } from "react";

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

// The host must remount this (`key={artifact.id}`) on artifact change:
// unlike stateless `ArtifactRenderer`, this has a local `value` buffer
// that would otherwise carry unsaved keystrokes onto the new content.
export function ArtifactTextEditor({
  content,
  title,
  readOnly,
  saveState,
  onSave,
}: ArtifactTextEditorProps) {
  const [value, setValue] = useState(content);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div className="shell-artifact-text-editor">
      <textarea
        // The pending debounced save dies with the textarea — a ref cleanup
        // rather than an effect that exists only to unmount.
        ref={() => () => {
          if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        }}
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
