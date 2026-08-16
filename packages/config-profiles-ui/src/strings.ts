// Every user-facing word `@corbits/config-profiles-ui` prints, in one
// place — this package's counterpart to
// packages/inference-settings/src/strings.ts. Nothing in
// apply-profile-panel.tsx or profiles-section.tsx inlines its own copy;
// they import from here. Copy speaks in outcomes ("which model answers
// first, and what's tried next") rather than the underlying platform
// vocabulary ("provider", "fallback order") wherever the two would say the
// same thing to a person applying a profile.

function ordinalPosition(position: number): string {
  if (position === 1) return "first";
  if (position === 2) return "second";
  if (position === 3) return "third";
  return `${String(position)}th`;
}

/** `${model} via ${provider}` — the one label every plan/result line
 * names its entry by. */
export function entryLabel(entry: {
  readonly provider: string;
  readonly model: string;
}): string {
  return `${entry.model} via ${entry.provider}`;
}

export const CONFIG_PROFILES_STRINGS = {
  loadError: "Couldn't load profiles.",
  saveError: "Couldn't save that profile.",
  deleteError: "Couldn't delete that profile.",
  applyError: "Couldn't apply that profile.",
  captureError: "Couldn't save the current setup.",
  planError: "Couldn't load a preview of that profile.",

  benchNoneSelectedTitle: "No workbench selected",
  benchNoneSelectedDescription: "Choose a workbench from the switcher first.",

  emptyTitle: "No profiles yet",
  emptyDescription:
    "Create a profile from scratch, or save a workbench's current setup as one.",
  emptyApplyTitle: "No profiles yet",
  emptyApplyDescription:
    "Create a profile from Settings to apply it here in one action.",

  createButton: "Create a profile",
  captureButton: "Save current setup as a profile",
  columnName: "Name",
  columnProviders: "Models",
  columnActions: "Actions",
  editButton: "Edit",
  deleteButton: "Delete",
  deleteConfirm:
    "Workbenches keep their current setup; this only removes the profile. Delete?",
  cancelButton: "Cancel",
  saveButton: "Save",
  savingButton: "Saving…",

  createProfileTitle: "Create a profile",
  editProfileTitle: "Edit profile",
  profileDialogDescription:
    "An ordered list of which model answers first, and what's tried next, that a workbench can apply in one action.",
  nameLabel: "Name",
  descriptionLabel: "Description (optional)",
  fallbackOrderLabel: "Which model answers first, and what's tried next",
  providerPlaceholder: "Provider",
  modelPlaceholder: "Model",
  disabledEntryLabel: "Skip this one here",
  removeEntryButton: "Remove",
  addEntryButton: "Add a model",

  captureDialogTitle: "Save current setup as a profile",
  captureDialogDescription:
    "Captures this workbench's fallback order as a new profile, so it can be applied to any workbench in one action.",
  captureNameLabel: "Name",

  createdToast: "Profile created.",
  savedToast: "Profile saved.",
  capturedToast: "Saved this workbench's setup as a profile.",
  deletedToast: (name: string) => `Deleted ${name}.`,

  applyPanelTitle: "Apply a profile",
  applyPanelDescription:
    "Attaching a profile sets this workbench's fallback order to match it in one action. Reordering or restricting a model afterward always wins over what the profile set.",
  chooseProfilePlaceholder: "Choose a profile…",
  applyButton: "Apply",
  applyingButton: "Applying…",
  appliedToast: (name: string) => `Applied ${name}.`,

  planLoadingLabel: "Loading preview…",
  planTitle: "What Apply will do",
  resultsTitle: "What happened",

  /** Plain-language line for one plan/result entry — shared by the
   * pre-Apply preview (future tense) and the post-Apply report (past
   * tense), since both walk the same `ApplyEntryResult` shape. */
  entryLine: (
    entry: {
      readonly provider: string;
      readonly model: string;
      readonly action:
        | "reordered"
        | "skipped-inherited"
        | "skipped-unavailable"
        | "failed"
        | "not-attempted";
      readonly priority?: number;
      readonly message?: string;
    },
    tense: "future" | "past",
  ): string => {
    const label = entryLabel(entry);
    switch (entry.action) {
      case "reordered": {
        const position = ordinalPosition((entry.priority ?? 0) + 1);
        return tense === "future"
          ? `${label} — will be ${position}`
          : `${label} — is now ${position}`;
      }
      case "skipped-inherited":
        return tense === "future"
          ? `${label} — needs a key here first`
          : `${label} — skipped, needs a key here first`;
      case "skipped-unavailable":
        return `${label} — not available here`;
      case "failed":
        return `${label} — failed${entry.message !== undefined ? `: ${entry.message}` : ""}`;
      case "not-attempted":
        return `${label} — not attempted (an earlier step failed first)`;
    }
  },
} as const;
