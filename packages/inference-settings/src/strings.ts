// Every user-facing word the Inference settings section prints, in one
// place — the inference-settings package's counterpart to
// packages/settings-ui/src/strings.ts. Nothing in inference-section.tsx
// inlines its own copy; it imports from here.

export const INFERENCE_STRINGS = {
  loadError: "Couldn't load the inference catalog.",
  hint: 'If the first model can\'t answer, the next one is tried, in this order. A row marked "Set here" is this workbench\'s own — reorder or restrict it directly. A row marked "Workbench default" is only editable once this workbench brings its own key for it.',
  emptyTitle: "No models in the catalog",
  emptyDescription:
    "Connect a provider in Keys & plugins to populate this workbench's inference catalog.",
  columnProvider: "Provider",
  columnStatus: "Status",
  columnActions: "Actions",
  provenanceSetHere: "Set here",
  provenanceInherited: "Workbench default",
  moveUp: "Move up",
  moveDown: "Move down",
  moveUpDisabledFirst: "Already first in the fallback order",
  moveDownDisabledLast: "Already last in the fallback order",
  moveDisabledNeighborInherited:
    "Bring your own key for the workbench default next to it before reordering past it",
  restrictAction: "Restrict",
  restrictConfirm: "Hide this from this workbench's fallback list?",
  restrictError: "Couldn't restrict that offering — try again.",
  reorderError: "Couldn't reorder that offering — try again.",
  restoreError: "Couldn't restore that offering — try again.",
  restrictedSectionTitle: "Restricted here",
  restrictedSectionHint:
    "These providers are hidden from this workbench's fallback list.",
  restoreAction: "Restore",
  byokAction: "Bring your own key",
  byokDialogTitle: (providerName: string) =>
    `Bring your own key for ${providerName}`,
  byokDialogDescription: (canonicalName: string, providerName: string) =>
    `This creates ${canonicalName} on ${providerName} as this workbench's own catalog entry, using a key only this workbench holds. Bringing a key for ${providerName} re-routes every model this workbench uses on ${providerName} through this key — not just ${canonicalName} — since a provider connection is shared across every model offered on it.`,
  byokBaseURLLabel: "Base URL",
  byokKeyLabel: "API key",
  byokCancel: "Cancel",
  byokSubmit: "Save",
  byokSubmitting: "Saving…",
  byokError: "Couldn't save that key — try again.",
  byokDoneToast: "Saved. This workbench now controls that provider.",
} as const;
