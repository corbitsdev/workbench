// The picker's row catalog: one entry per selectable kind, plus the
// disabled "more kinds soon" row. `code-review` and `blank` are pinned to
// the approved mock (CL-6342) verbatim; `due-diligence` mirrors the
// backend's `DUE_DILIGENCE_TEMPLATE` (`@corbits/workflow-catalog`, CL-6499)
// — it and every other id here are still gated by what this bench's
// library actually serves before either is offered as a live row (see
// `NewWorkbenchPickerRoute`'s `servedTemplateIds`). See
// `pages/new-workbench-picker.tsx` for the row rendering and
// `instant-agent-create.ts`'s `createWorkbenchFromTemplate` for what
// picking one actually does today.

export type WorkbenchTemplateId = "code-review" | "due-diligence" | "blank";

export type WorkbenchTemplate = {
  readonly id: WorkbenchTemplateId;
  readonly title: string;
  readonly promise: string;
};

export const WORKBENCH_TEMPLATES: readonly WorkbenchTemplate[] = [
  {
    id: "code-review",
    title: "Code review",
    promise:
      "Three reviewers read every pull request and post what they'd change.",
  },
  {
    id: "due-diligence",
    title: "Research & due diligence",
    promise:
      "Scout researches the web and what your team already knows, and saves what it finds so you can pick it up later.",
  },
  {
    id: "blank",
    title: "Just start talking",
    promise:
      "An empty room with Myra in it. Bring your own work, connect things as you go.",
  },
];

/** The disabled third row — not a real template, never selectable. */
export const COMING_SOON_ROW = {
  title: "More kinds soon",
  promise: "Standups, incident recaps, on-call triage.",
} as const;
