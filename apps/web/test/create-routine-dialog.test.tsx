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

import type { APIQuery } from "../src/api";
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
    name: "Researcher",
    status: "deployed",
    description: "Pulls research",
  },
  { id: "wfd_2", name: "Summarizer", status: "deployed" },
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
