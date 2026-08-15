// DOM-mounted coverage for the "New routine" guided stepper: step
// transitions, the catalog path creating with zero typing beyond picks
// (name defaults to the workflow's friendly name), back navigation keeping
// state, and the shared stepper chrome rendering. `CreateRoutineDialog`
// itself stays private — exercised the same way a person would, through
// `RoutinesListPage`'s "New routine" action.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { APIQuery } from "@corbits/api-query";
import {
  requestMakeRoutine,
  resetPendingDialogRequests,
} from "../src/command-palette-actions";
import { RoutinesListPage } from "../src/pages/routines-page";
import type {
  CreateRoutineInput,
  Routine,
  RoutineDraft,
  RoutineRun,
} from "../src/routines-api";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const textareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)?.set;
if (textareaValueSetter === undefined) {
  throw new Error("HTMLTextAreaElement.prototype.value has no native setter");
}

const maybeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)?.set;
if (maybeInputValueSetter === undefined) {
  throw new Error("HTMLInputElement.prototype.value has no native setter");
}
const inputValueSetter = maybeInputValueSetter;

function typeInto(input: HTMLInputElement | null, value: string) {
  act(() => {
    inputValueSetter.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof RoutinesListPage>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(RoutinesListPage, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
  resetPendingDialogRequests();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
}

/** Workflow cards carry a title plus a description in the same button, so
 * an exact match never hits — this matches on the leading title text. */
function cardWithTitle(title: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.trim().startsWith(title),
  );
}

const definitions = [
  {
    id: "wfd_1",
    assetName: "researcher",
    name: "Researcher",
    status: "deployed",
    description: "Pulls research",
    whatItDoes: "Pulls research from connected sources.",
    requiredConnections: [],
    exampleOutput: "Research summary, three sources cited.",
    typicalDuration: "a few minutes",
    triggerFields: [],
  },
  {
    id: "wfd_2",
    assetName: "summarizer",
    name: "Summarizer",
    status: "deployed",
    whatItDoes: "Summarizes a document into a short brief.",
    requiredConnections: [],
    exampleOutput: "A three-paragraph summary of the source document.",
    typicalDuration: "under a minute",
    triggerFields: [],
  },
  {
    id: "wfd_3",
    assetName: "last-30-days-research",
    name: "Last 30 days research report",
    status: "deployed",
    whatItDoes: "Researches a topic over the last 30 days.",
    requiredConnections: [],
    exampleOutput: "Cited report: 3 new competing launches this month",
    typicalDuration: "1-2 minutes",
    triggerFields: [
      {
        key: "topic",
        label: "Topic",
        placeholder: "AI coding agents",
        required: true,
        help: "What to research over the last 30 days.",
      },
      {
        key: "focus",
        label: "Focus",
        placeholder: "Competing launches",
        required: false,
        help: "Optional — narrows which angle of the topic to chase.",
      },
    ],
  },
  {
    // Mirrors packages/workflow-catalog's real "recurring-task" entry —
    // the "Make this a routine" bridge (see inbox-page.tsx) prefills
    // THIS card's id, never a task's own (conversational, never
    // automatable) agent id.
    id: "wfd_recurring_task",
    assetName: "recurring-task",
    name: "Recurring task",
    status: "deployed",
    whatItDoes: "Runs a task prompt through a picked agent on a schedule.",
    requiredConnections: [],
    exampleOutput: "Delivered to your Inbox, same as a manual task's reply",
    typicalDuration: "same as the agent's own manual-task duration",
    triggerFields: [
      {
        key: "agent",
        label: "Agent",
        placeholder: "wfd_...",
        required: true,
        help: "The agent this recurring task runs.",
      },
      {
        key: "prompt",
        label: "Prompt",
        placeholder: "Summarize last night's incidents",
        required: true,
        help: "What to ask the agent to do, every time this routine fires.",
      },
    ],
  },
] as const;

const channels = [
  {
    id: "ch_1",
    title: "Ops",
    kind: "channel" as const,
    pinned: false,
    participants: [],
  },
];

function baseProps(overrides: {
  onCreate?: (input: CreateRoutineInput) => Promise<void>;
  onDescribe?: () => Promise<RoutineDraft>;
  onApproveDraft?: (draftId: string) => Promise<void>;
}) {
  return {
    routines: ready([] as readonly Routine[]),
    runHistories: new Map<string, readonly RoutineRun[]>(),
    liveRuns: ready([]),
    definitions,
    channels,
    selectedId: null,
    onSelect: () => {},
    onCreate: overrides.onCreate ?? (() => Promise.resolve()),
    onCreateWebhookBinding: () =>
      Promise.resolve({ id: "wht_1", secret: "test-secret" }),
    webhookTrigger: null,
    onRotateWebhookSecret: () => Promise.resolve({ secret: "rotated-secret" }),
    onDescribe:
      overrides.onDescribe ??
      (() =>
        Promise.resolve({
          id: "draft_1",
          prompt: "test",
          status: "draft" as const,
          proposedSteps: [],
          proposedTrigger: null,
          proposedName: null,
          definitionId: null,
          deliveryChannelId: "ch_1",
          scope: "bench" as const,
          autonomy: null,
          approvedRoutineId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
    onApproveDraft: overrides.onApproveDraft ?? (() => Promise.resolve()),
    onDiscardDraft: () => Promise.resolve(),
    onToggleEnabled: () => {},
    onRunNow: () => Promise.resolve(),
    onEdit: () => Promise.resolve(),
    onOpenRuns: () => {},
    onOpenChannel: () => {},
  };
}

async function openDialog() {
  mount(baseProps({}));
  await settle();
  const openButton = buttonWithText("New routine");
  act(() => {
    openButton?.click();
  });
  await settle();
}

describe("CreateRoutineDialog stepper", () => {
  test("renders the shared stepper chrome, starting on Source", async () => {
    await openDialog();

    expect(document.body.querySelector(".dialog-stepper")).not.toBeNull();
    expect(document.body.textContent).toContain("Step 1 of 3");
    expect(document.body.textContent).toContain("Source");
    expect(document.body.textContent).toContain("Researcher");
    expect(document.body.textContent).toContain("Describe it to an agent");
  });

  test("picker cards clamp exampleOutput to two lines", async () => {
    await openDialog();

    const card = cardWithTitle("Researcher");
    const teaser = card?.querySelector(".line-clamp-2");
    expect(teaser?.textContent).toBe("Research summary, three sources cited.");
  });

  test("the Configure step shows the full, unclamped example output for the picked workflow", async () => {
    await openDialog();

    act(() => {
      cardWithTitle("Summarizer")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Example output");
    expect(document.body.textContent).toContain(
      "A three-paragraph summary of the source document.",
    );
    const exampleNode = [...document.body.querySelectorAll("span")].find(
      (span) =>
        span.textContent ===
        "A three-paragraph summary of the source document.",
    );
    expect(exampleNode?.className).not.toContain("line-clamp");
  });

  test("Next advances through Configure to Confirm for a catalog pick", async () => {
    await openDialog();

    act(() => {
      cardWithTitle("Researcher")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Step 2 of 3");
    expect(document.body.textContent).toContain("When");

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Step 3 of 3");
    expect(document.body.textContent).toContain("Name (optional)");
  });

  test("a catalog routine can be created with zero typing beyond picks", async () => {
    let created: CreateRoutineInput | null = null;
    mount(
      baseProps({
        onCreate: (input) => {
          created = input;
          return Promise.resolve();
        },
      }),
    );
    await settle();
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();

    act(() => {
      cardWithTitle("Researcher")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    const createButton = buttonWithText("Create & run now");
    expect(createButton?.hasAttribute("disabled")).toBe(false);
    act(() => {
      createButton?.click();
    });
    await settle();

    expect(created).not.toBeNull();
    expect((created as CreateRoutineInput | null)?.name).toBe("Researcher");
    expect((created as CreateRoutineInput | null)?.definitionId).toBe("wfd_1");
    expect((created as CreateRoutineInput | null)?.runOnceNow).toBe(true);
  });

  test("Back returns to Source without losing the picked workflow", async () => {
    await openDialog();

    act(() => {
      cardWithTitle("Summarizer")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Step 2 of 3");

    act(() => {
      buttonWithText("Back")?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Step 1 of 3");
    expect(cardWithTitle("Summarizer")?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Step 2 of 3");
  });

  test("the describe path drafts, reviews, and approves", async () => {
    let approvedId: string | null = null;
    mount(
      baseProps({
        onDescribe: () =>
          Promise.resolve({
            id: "draft_9",
            prompt: "Summarize signups daily",
            status: "draft" as const,
            proposedSteps: [{ title: "Pull signups" }],
            proposedTrigger: null,
            proposedName: "Daily signups",
            definitionId: null,
            deliveryChannelId: "ch_1",
            scope: "bench" as const,
            autonomy: null,
            approvedRoutineId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        onApproveDraft: (draftId) => {
          approvedId = draftId;
          return Promise.resolve();
        },
      }),
    );
    await settle();
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();

    act(() => {
      cardWithTitle("Describe it to an agent")?.click();
    });
    const textarea = document.body.querySelector(
      "#routine-prompt",
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    act(() => {
      textareaValueSetter.call(textarea, "Summarize signups daily");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    act(() => {
      buttonWithText("Draft with agent")?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Pull signups");

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Step 3 of 3");
    expect(document.body.textContent).toContain("Daily signups");

    act(() => {
      buttonWithText("Approve")?.click();
    });
    await settle();

    expect(approvedId as string | null).toBe("draft_9");
  });
});

describe("CreateRoutineDialog trigger fields", () => {
  test("Configure shows no trigger-inputs section for a workflow with none declared", async () => {
    await openDialog();

    act(() => {
      cardWithTitle("Researcher")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    expect(document.body.textContent).not.toContain("Trigger inputs");
  });

  test("Configure renders a declared triggerFields step: required field blocks Next until filled", async () => {
    await openDialog();

    act(() => {
      cardWithTitle("Last 30 days research report")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Trigger inputs");
    expect(document.body.textContent).toContain("Topic");
    expect(document.body.textContent).toContain("Focus (optional)");

    const nextButton = buttonWithText("Next");
    expect(nextButton?.hasAttribute("disabled")).toBe(true);

    const topicInput = document.body.querySelector(
      "#routine-trigger-field-topic",
    ) as HTMLInputElement | null;
    expect(topicInput).not.toBeNull();
    typeInto(topicInput, "AI coding agents");

    expect(buttonWithText("Next")?.hasAttribute("disabled")).toBe(false);
  });

  test("filled trigger field values thread into the fired routine's input, keyed by field key", async () => {
    let created: CreateRoutineInput | null = null;
    mount(
      baseProps({
        onCreate: (input) => {
          created = input;
          return Promise.resolve();
        },
      }),
    );
    await settle();
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();

    act(() => {
      cardWithTitle("Last 30 days research report")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    typeInto(
      document.body.querySelector(
        "#routine-trigger-field-topic",
      ) as HTMLInputElement | null,
      "AI coding agents",
    );
    typeInto(
      document.body.querySelector(
        "#routine-trigger-field-focus",
      ) as HTMLInputElement | null,
      "Competing launches",
    );

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    const createButton = buttonWithText("Create & run now");
    act(() => {
      createButton?.click();
    });
    await settle();

    expect((created as CreateRoutineInput | null)?.input).toEqual({
      topic: "AI coding agents",
      focus: "Competing launches",
    });
  });

  test("an unfilled optional trigger field is omitted from the fired input, not sent blank", async () => {
    let created: CreateRoutineInput | null = null;
    mount(
      baseProps({
        onCreate: (input) => {
          created = input;
          return Promise.resolve();
        },
      }),
    );
    await settle();
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();

    act(() => {
      cardWithTitle("Last 30 days research report")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    typeInto(
      document.body.querySelector(
        "#routine-trigger-field-topic",
      ) as HTMLInputElement | null,
      "AI coding agents",
    );

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    act(() => {
      buttonWithText("Create & run now")?.click();
    });
    await settle();

    expect((created as CreateRoutineInput | null)?.input).toEqual({
      topic: "AI coding agents",
    });
  });
});

describe("CreateRoutineDialog webhook mode", () => {
  test("creates the webhook binding, then the routine referencing it, and reveals the secret once", async () => {
    let boundName: string | null = null;
    let boundDefinitionId: string | null = null;
    let created: CreateRoutineInput | null = null;
    // baseProps doesn't let onCreateWebhookBinding be overridden directly —
    // spread its result and override that one field instead.
    const props = {
      ...baseProps({
        onCreate: (input) => {
          created = input;
          return Promise.resolve();
        },
      }),
      onCreateWebhookBinding: (input: {
        name: string;
        definitionId: string;
      }) => {
        boundName = input.name;
        boundDefinitionId = input.definitionId;
        return Promise.resolve({ id: "wht_new", secret: "s3cr3t-value" });
      },
    };
    mount(props);
    await settle();
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();

    act(() => {
      cardWithTitle("Researcher")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    act(() => {
      buttonWithText("On webhook")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain(
      "A hook URL and signing secret are generated",
    );

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Fires on webhook delivery");

    const createButton = buttonWithText("Create routine");
    expect(createButton).not.toBeUndefined();
    act(() => {
      createButton?.click();
    });
    await settle();

    expect(boundName as string | null).toBe("Researcher");
    expect(boundDefinitionId as string | null).toBe("wfd_1");
    expect((created as CreateRoutineInput | null)?.trigger).toEqual({
      kind: "webhook",
      webhookTriggerId: "wht_new",
    });
    expect((created as CreateRoutineInput | null)?.runOnceNow).toBe(false);

    // The secret is shown exactly once, right after creation — the
    // dialog stays open on a reveal panel instead of closing immediately.
    expect(document.body.textContent).toContain("s3cr3t-value");
    expect(document.body.textContent).toContain("shown once");

    act(() => {
      buttonWithText("Done")?.click();
    });
    await settle();
    expect(document.body.textContent).not.toContain("s3cr3t-value");
  });
});

describe("'Make this a routine' prefill", () => {
  // Targets the recurring-task bridge workflow's id, never a task's own
  // (conversational, never automatable) agent id — see
  // apps/hub/src/routine-launcher.ts and inbox-page.tsx's onMakeRoutine
  // for why. `input` matches that workflow's own declared trigger
  // fields (`agent`, `prompt`) exactly, the same seam a manually-picked
  // catalog workflow's trigger fields go through.
  const prefill = {
    definitionId: "wfd_recurring_task",
    name: "Summarize last night's incident",
    input: {
      agent: "wfd_summarizer",
      prompt: "Summarize last night's incident into a postmortem.",
    },
  };

  test("opens the dialog with the recurring-task card picked, its trigger fields rendered, and its name pre-filled", async () => {
    requestMakeRoutine({
      alreadyOnRoutines: false,
      navigateToRoutines: () => {},
      prefill,
    });
    mount(baseProps({}));
    await settle();

    expect(document.body.textContent).toContain("Step 1 of 3");
    expect(cardWithTitle("Recurring task")?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    // The picked workflow's own trigger fields render at Configure —
    // proof the dialog is not stuck with an unresolved definitionId.
    expect(document.body.textContent).toContain("Agent");
    expect(document.body.textContent).toContain("Prompt");

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    const nameInput = document.body.querySelector(
      "#routine-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value).toBe(prefill.name);
    // Create is enabled — a resolved definitionId with its required
    // trigger fields already satisfied by the prefill.
    expect(buttonWithText("Create & run now")?.hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("carries the task's agent and prompt through as the created routine's stored trigger-field input", async () => {
    let created: CreateRoutineInput | null = null;
    requestMakeRoutine({
      alreadyOnRoutines: false,
      navigateToRoutines: () => {},
      prefill,
    });
    mount(
      baseProps({
        onCreate: (input) => {
          created = input;
          return Promise.resolve();
        },
      }),
    );
    await settle();

    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    act(() => {
      buttonWithText("Create & run now")?.click();
    });
    await settle();

    expect(created).not.toBeNull();
    expect((created as CreateRoutineInput | null)?.definitionId).toBe(
      "wfd_recurring_task",
    );
    expect((created as CreateRoutineInput | null)?.name).toBe(prefill.name);
    expect((created as CreateRoutineInput | null)?.input).toEqual(
      prefill.input,
    );
  });

  test("cancelling a prefilled dialog creates nothing", async () => {
    let createCalls = 0;
    requestMakeRoutine({
      alreadyOnRoutines: false,
      navigateToRoutines: () => {},
      prefill,
    });
    mount(
      baseProps({
        onCreate: () => {
          createCalls += 1;
          return Promise.resolve();
        },
      }),
    );
    await settle();
    expect(cardWithTitle("Recurring task")?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    const closeButton = document.body.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();
    act(() => {
      closeButton?.click();
    });
    await settle();

    expect(createCalls).toBe(0);
    expect(document.body.querySelector(".dialog-stepper")).toBeNull();

    // Re-opening blank afterward must not still carry the cancelled prefill.
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();
    expect(
      cardWithTitle("Recurring task")?.getAttribute("aria-pressed"),
    ).not.toBe("true");
  });

  test("regression: a prefilled definitionId absent from the catalog is not treated as a valid pick — no dead end", async () => {
    // Reproduces the critique's exact failure: prefilling with a task's
    // own (conversational, never-automatable) agent id, which never
    // resolves in `definitions`. Before the fix, this silently let the
    // stepper advance to a Configure/Confirm step with no
    // selectedDefinition to launch against.
    requestMakeRoutine({
      alreadyOnRoutines: false,
      navigateToRoutines: () => {},
      prefill: {
        definitionId: "wfd_conversational_agent_not_in_catalog",
        name: "Should never resolve",
        input: {},
      },
    });
    mount(baseProps({}));
    await settle();

    expect(document.body.textContent).toContain(
      "isn't in your automatable catalog",
    );
    const nextButton = buttonWithText("Next");
    expect(nextButton?.hasAttribute("disabled")).toBe(true);
  });
});
