// The picker's prefab catalog: one entry per one-click shortcut card
// (CL-6628). `code-review` and `blank` are pinned to the approved mock
// (CL-6342) verbatim; `due-diligence` mirrors the backend's
// `DUE_DILIGENCE_TEMPLATE` (`@workbench/templates`, CL-6499) — it and
// every other id here are still gated by what this bench's library
// actually serves before either is offered as a live card (see
// `NewWorkbenchPickerRoute`'s `servedTemplateIds`). See
// `pages/new-workbench-picker.tsx` for the card rendering and
// `instant-agent-create.ts`'s `createWorkbenchFromTemplate` for what
// picking one — or typing a goal into the prompt box above them —
// actually does today.

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
    title: "Due Diligence",
    promise:
      "Scout checks a company, deal, or vendor against the web and what your team already knows, and saves what it finds so you can pick it up later.",
  },
  {
    id: "blank",
    title: "Just start talking",
    promise:
      "An empty channel. Nobody is hosted. Invite people and agents as you go.",
  },
];
