// Every user-facing word the Inference settings section prints, in one
// place — the inference-settings package's counterpart to
// packages/settings-ui/src/strings.ts. Nothing in inference-section.tsx
// inlines its own copy; it imports from here.

export const INFERENCE_STRINGS = {
  loadError: "Couldn't load the model list.",
  heading: "Models",
  hint: "Myra and this workbench's agents use the first model that works; drag/Move to change the order.",
  emptyTitle: "No models in the catalog",
  emptyDescription:
    "Connect a provider in Keys & plugins to populate this workbench's inference catalog.",
  columnProvider: "Provider",
  columnStatus: "Status",
  columnActions: "Actions",
  provenanceSetHere: "Connected here",
  provenanceInherited: "Shared",
  moveUp: "Move up",
  moveDown: "Move down",
  moveUpDisabledFirst: "Already first in the fallback order",
  moveDownDisabledLast: "Already last in the fallback order",
  moveDisabledNeighborInherited:
    "Bring your own key for the shared one next to it before reordering past it",
  restrictAction: "Don't use here",
  restrictConfirm: "Stop using this model here?",
  restrictError: "Couldn't stop using that model here — try again.",
  reorderError: "Couldn't change the order — try again.",
  restoreError: "Couldn't bring that model back — try again.",
  restrictedSectionTitle: "Not used here",
  restrictedSectionHint:
    "These models are set up but this workbench isn't using them.",
  restoreAction: "Use here",
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
