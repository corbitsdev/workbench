/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { RunState, StepState } from "@intx/workflow";
import type { WorkflowPanelProps } from "@workbench/ui";

afterEach(cleanup);

const { Panel } = await import("./ui");

type Phase = StepState["phase"];

function makeState(phases: Partial<Record<string, Phase>>): RunState {
  const steps = new Map<string, StepState>();
  for (const [stepId, phase] of Object.entries(phases)) {
    if (!phase) continue;
    steps.set(stepId, {
      stepId,
      phase,
      currentAttempt: 1,
    } as unknown as StepState);
  }
  return {
    phase: "running",
    steps,
  } as unknown as RunState;
}

// Agent step output: enrich emits { reply: "<JSON>", turn: ... }
function makeEnrichOutput(
  rows: { id: string; field: string; value: string; note?: string }[],
) {
  return { reply: JSON.stringify({ rows }), turn: null };
}

// Deterministic persist step output: { callId, content: "<JSON>" }
function makePersistOutput(artifact: {
  artifactId?: string;
  title?: string;
  kind?: string;
  version?: number;
}) {
  return { callId: "det-persist", content: JSON.stringify(artifact) };
}

const sampleEnrichOutput = makeEnrichOutput([
  {
    id: "title",
    field: "title",
    value: "Best Widget Ever",
    note: "strong hook",
  },
  {
    id: "meta_description",
    field: "meta_description",
    value: "Buy the best widget.",
  },
]);

function renderPanel(overrides: Partial<WorkflowPanelProps> = {}) {
  const onSignal = mock((_name: string, _payload?: unknown) => {});
  const onClose = mock(() => {});
  const props: WorkflowPanelProps = {
    deploymentId: "dep_1",
    state: makeState({}),
    connected: true,
    stepOutputs: {},
    signalPending: false,
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

describe("Panel", () => {
  it("renders the header and every step label", () => {
    renderPanel();
    screen.getByText("SEO Enrichment from Image");
    for (const label of ["Intake", "Enrich", "Review", "Persist"]) {
      screen.getByText(label);
    }
  });

  it("renders the intake form while intake is awaiting its signal", () => {
    renderPanel({ state: makeState({ intake: "awaiting-signal" }) });
    screen.getByLabelText("Product image URL");
    screen.getByLabelText("Target page URL");
    screen.getByText("Start enrichment");
  });

  it("keeps Start enrichment disabled while fields are empty", () => {
    renderPanel({ state: makeState({ intake: "awaiting-signal" }) });
    const button = screen.getByText("Start enrichment") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  });

  it("fires onSignal with intake payload when both URLs are filled and submitted", () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: "awaiting-signal" }),
    });
    fireEvent.change(screen.getByLabelText("Product image URL"), {
      target: { value: "https://example.com/product.jpg" },
    });
    fireEvent.change(screen.getByLabelText("Target page URL"), {
      target: { value: "https://example.com/page" },
    });
    fireEvent.click(screen.getByText("Start enrichment"));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "intake",
      {
        imageUrl: "https://example.com/product.jpg",
        pageUrl: "https://example.com/page",
      },
    ]);
  });

  it("shows the in-flight message while enrich is running", () => {
    renderPanel({
      state: makeState({ intake: "completed", enrich: "in-flight" }),
    });
    // Shown both as the body placeholder and on the persistent live status line.
    expect(
      screen.getAllByText("Extracting SEO metadata…").length,
    ).toBeGreaterThan(0);
  });

  it("does not rewind to intake when the intake gate's output is absent but enrich is running (CL-2506)", () => {
    // The intake awaitSignal gate's StepCompleted is missing from the
    // synthesized state, but enrich is in-flight: the panel must stay on Enrich,
    // not fall back to the intake form.
    renderPanel({ state: makeState({ enrich: "in-flight" }) });
    expect(
      screen.getAllByText("Extracting SEO metadata…").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Start enrichment")).toBeNull();
  });

  it("renders extracted metadata rows from the enrich step reply", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
    });
    screen.getByText("title");
    screen.getByText("Best Widget Ever");
    screen.getByText("strong hook");
    screen.getByText("meta_description");
    screen.getByText("Buy the best widget.");
  });

  it("shows checkboxes for each row, pre-checked, in review step", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
    });
    const titleCheckbox = screen.getByLabelText(
      "Select title",
    ) as HTMLInputElement;
    const metaCheckbox = screen.getByLabelText(
      "Select meta_description",
    ) as HTMLInputElement;
    expect(titleCheckbox.checked).toBe(true);
    expect(metaCheckbox.checked).toBe(true);
  });

  it("fires onSignal with row-selection payload containing only checked ids", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
    });
    // Uncheck the second row
    fireEvent.click(screen.getByLabelText("Select meta_description"));
    fireEvent.click(screen.getByText("Save selected rows"));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "row-selection",
      { selectedIds: ["title"] },
    ]);
  });

  it("keeps Save selected rows disabled when all rows are unchecked", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
    });
    fireEvent.click(screen.getByLabelText("Select title"));
    fireEvent.click(screen.getByLabelText("Select meta_description"));
    const button = screen.getByText("Save selected rows") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("renders the saved artifact title and kind from the persist step envelope", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "completed",
        persist: "completed",
      }),
      stepOutputs: {
        persist: makePersistOutput({
          artifactId: "art_1",
          title: "SEO Enrichment Results",
          kind: "document",
          version: 1,
        }),
      },
    });
    screen.getByText("SEO Enrichment Results");
    screen.getByText("document");
  });

  it("shows a failure message when the run failed", () => {
    renderPanel({
      state: { phase: "failed", steps: new Map() } as unknown as RunState,
    });
    screen.getByText("Run failed");
    screen.getByText(/No error details are available/);
  });

  it("names the failed step and shows the sanitized error, never raw internals (CL-2659)", () => {
    const steps = new Map<string, StepState>();
    steps.set("intake", { stepId: "intake", phase: "completed" } as StepState);
    steps.set("enrich", {
      stepId: "enrich",
      phase: "failed",
      currentAttempt: 1,
      lastError: {
        message:
          "TypeError: boom at run (ins_01abc/ses_01def) /app/steps/enrich.ts:42:7",
      },
    } as StepState);
    renderPanel({ state: { phase: "failed", steps } as unknown as RunState });
    screen.getByText("Run failed at Enrich");
    screen.getByText(/Something went wrong inside this workflow run/);
    expect(screen.queryByText(/ins_/)).toBeNull();
    expect(screen.queryByText(/ses_/)).toBeNull();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  it("shows a malformed-output error when enrich output fails validation (completed step)", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: { reply: '{"rows":"not-an-array"}' } },
    });
    screen.getByText("Couldn't read the enrichment output.");
  });

  it("fires onClose when Close is clicked", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows only the active step (guided mode) — intake hides enrich content", () => {
    renderPanel({
      state: makeState({ intake: "awaiting-signal" }),
      stepOutputs: { enrich: sampleEnrichOutput },
    });
    expect(screen.queryByText("Extracting SEO metadata…")).toBeNull();
    expect(screen.queryByText("Waiting for enrichment.")).toBeNull();
    screen.getByLabelText("Product image URL");
  });

  it("shows only the active step — review hides intake form", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
    });
    expect(screen.queryByLabelText("Product image URL")).toBeNull();
    screen.getByText("Save selected rows");
  });

  it("disables Save selected rows while disconnected", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
      connected: false,
    });
    const button = screen.getByText("Save selected rows") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("disables Save selected rows while a signal is pending", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        enrich: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { enrich: sampleEnrichOutput },
      signalPending: true,
    });
    const button = screen.getByText("Save selected rows") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });
});
