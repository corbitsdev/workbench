// The known-drift ledger for check:react-ui-drift — every file listed here
// is excluded from the (a) raw-form-control and (d) raw-button counts
// because its raw DOM is tracked work for a lane other than the one that
// last touched this file, not an oversight. A file only belongs here once
// it actually trips one of those two classes; grep before adding a row.
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
    ticket: "CL-6066",
  },
  {
    relPath: "packages/tasks-ui/src/myra-agent-selection-strategy.tsx",
    ticket: "CL-6066",
  },
  {
    relPath: "packages/chat-ui/src/timeline.tsx",
    ticket: "CL-6067",
  },
  {
    relPath: "apps/web/src/pages/insights-page.tsx",
    ticket: "wave 3 lane",
  },
];

export const REACT_UI_DRIFT_SNAPSHOT = 55;
