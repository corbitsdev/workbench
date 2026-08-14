// The editable half of a text-kind artifact's canvas pane (CL-5958 phase
// 2), built on top of `ArtifactRenderer`'s read-only phase-1 surface
// rather than replacing it: `ArtifactRenderer` still owns every other
// kind, and a viewer with no write access still renders through it
// read-only. This component only ever mounts for a "doc"-kind artifact
// once the host has already decided the viewer can edit — it never makes
// that call itself.
//
// The `Y.Doc` is a shared, already-synced document the host connects
// over `@corbits/presence/client` (a plain textarea bound to `Y.Text` via
// `y-text-diff.ts`'s diff-and-replay, not a rich-text editor dependency)
// — this component never imports `@corbits/presence` itself, the same
// "take plain data as props" boundary `canvas-column.tsx` already holds
// with `PresenceCursor`.
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { applyTextDiffToYText } from "./y-text-diff";
import { formatSaveStateLine, type ArtifactSaveState } from "./save-state";

const TEXT_FIELD = "content";
const TYPING_IDLE_MS = 2_000;

export interface ArtifactTextEditorProps {
  /** The room's shared doc — already synced via `@corbits/presence/client`'s `doc` option. */
  readonly doc: Y.Doc;
  readonly title: string;
  /** No write access: renders the live-updating text but ignores keystrokes. */
  readonly readOnly: boolean;
  readonly saveState: ArtifactSaveState;
  /** Fired on typing start/stop (debounced at `TYPING_IDLE_MS`) — the host publishes this through presence's existing `typing` awareness field. */
  readonly onLocalTyping?: (typing: boolean) => void;
}

export function ArtifactTextEditor({
  doc,
  title,
  readOnly,
  saveState,
  onLocalTyping,
}: ArtifactTextEditorProps) {
  const yText = doc.getText(TEXT_FIELD);
  const [value, setValue] = useState(() => yText.toString());
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    const syncFromDoc = () => {
      const next = yText.toString();
      setValue((current) => (current === next ? current : next));
    };
    syncFromDoc();
    yText.observe(syncFromDoc);
    return () => yText.unobserve(syncFromDoc);
  }, [yText]);

  useEffect(
    () => () => {
      if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current);
    },
    [],
  );

  const markTyping = () => {
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      onLocalTyping?.(true);
    }
    if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      onLocalTyping?.(false);
    }, TYPING_IDLE_MS);
  };

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
          // `applyTextDiffToYText` reads `yText`'s own live content, not
          // `value` — a remote update could have raced in since this
          // component's last render, and diffing against a stale `value`
          // would corrupt the doc (see y-text-diff.ts). `setValue` still
          // reflects `next` immediately for responsive typing; the
          // `yText.observe` effect above reconciles it to whatever the
          // doc actually ends up holding.
          applyTextDiffToYText(yText, next);
          setValue(next);
          markTyping();
        }}
      />
      <div className="shell-artifact-save-state" aria-live="polite">
        {formatSaveStateLine(saveState, Date.now())}
      </div>
    </div>
  );
}
