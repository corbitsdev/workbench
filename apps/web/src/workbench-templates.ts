// The picker's row catalog (CL-6342): one entry per selectable kind, plus
// the disabled "more kinds soon" row. Copy is pinned to the approved mock
// verbatim — see `pages/new-workbench-picker.tsx` for the row rendering
// and `instant-agent-create.ts`'s `createWorkbenchFromTemplate` for what
// picking one actually does today.

export type WorkbenchTemplateId = "code-review" | "blank";

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
