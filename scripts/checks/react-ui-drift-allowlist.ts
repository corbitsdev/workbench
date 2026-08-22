// The known-drift ledger for check:react-ui-drift — every file listed here
// is excluded from the (a) raw-form-control and (d) raw-button counts
// because its raw DOM is tracked work for a lane other than the one that
// last touched this file, not an oversight. A file only belongs here once
// it actually trips one of those two classes; grep before adding a row.
//
// A row also stops belonging here the moment its file stops tripping a
// class — `packages/chat-ui/src/timeline.tsx` was carried long after it had
// nothing left to exclude, since it imports react-ui's `Button` and that
// takes it out of the raw-button class outright. A stale row reads as
// accepted debt that isn't there, and every row here once cited a ticket
// that had closed (or, for one, no ticket at all), which hid that the ledger
// had no live work behind it. `ticket` must therefore name an OPEN issue:
// if the work is done, delete the row instead of repointing it. Run the
// check after removing a row — the checker's classes are narrower than a
// grep, so "this file looks clean" is not the same as it counting zero.
//
// `REACT_UI_DRIFT_SNAPSHOT` is the total ratcheted violation count (raw
// form controls outside this list + every raw `<table>` + raw buttons
// outside this list) recorded the last time this ledger was updated.
// check:react-ui-drift fails only when the live count exceeds this number,
// so lowering it is how a cleanup lane proves it actually reduced drift —
// bump it back up only alongside a change that both adds new raw DOM and
// justifies why (which should be rare; most new UI should use react-ui
// primitives directly and never need this file touched at all).
export interface DriftAllowlistEntry {
  readonly relPath: string;
  /** Why this file still carries raw DOM instead of a react-ui primitive. */
  readonly ticket: string;
}

export const REACT_UI_DRIFT_ALLOWLIST: readonly DriftAllowlistEntry[] = [
  {
    relPath: "packages/tasks-ui/src/task-composer-dialog.tsx",
    ticket: "CL-6320",
  },
  {
    relPath: "packages/tasks-ui/src/myra-agent-selection-strategy.tsx",
    ticket: "CL-6320",
  },
  {
    relPath: "apps/web/src/pages/insights-page.tsx",
    ticket: "CL-6320",
  },
];

// CL-6628 adds the prompt box's `<textarea>` — react-ui has no Textarea
// primitive, and every existing multi-line input in this codebase
// (composer.tsx, form-block.tsx, general-section.tsx, ...) is the same raw
// element, so this follows the established convention rather than
// inventing a one-off wrapper.
export const REACT_UI_DRIFT_SNAPSHOT = 49;
