/// <reference types="bun" />
import "../test-setup";
import { useState } from "react";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ScheduleFieldMetadata,
  ScheduleRecurrence,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import { buildScheduleFlowSteps, ScheduleFlow } from "./ScheduleFlow";

const baseEntry: WorkflowCatalogEntry = {
  kind: "gamma",
  label: "Gamma",
  description: "Make decks",
  isFavorite: false,
  stepCount: 1,
  pauseCount: 0,
  steps: [],
  attachable: true,
  allowedScopes: ["personal", "tenant"],
  defaultScope: "personal",
  intakeFields: [],
};

const topicFields: ScheduleFieldMetadata[] = [
  {
    name: "topic",
    label: "Topic",
    inputHint: "text",
    required: true,
    order: 0,
  },
];

const daily: ScheduleRecurrence = {
  intervalMinutes: 1440,
  anchorMinuteUtc: 14 * 60,
};

afterEach(() => {
  cleanup();
});

describe("buildScheduleFlowSteps", () => {
  it("always includes open and recurrence", () => {
    expect(
      buildScheduleFlowSteps({ hasInputFields: false, canChooseScope: false }),
    ).toEqual(["open", "recurrence"]);
  });

  it("adds inputs and availability when applicable", () => {
    expect(
      buildScheduleFlowSteps({ hasInputFields: true, canChooseScope: true }),
    ).toEqual(["open", "recurrence", "inputs", "availability"]);
  });
});

describe("ScheduleFlow", () => {
  it("walks Open → Recurrence → Availability for multi-scope empty-input kinds", () => {
    const onSave = mock(() => undefined);
    render(
      <ScheduleFlow
        entry={baseEntry}
        productLabel="Gamma"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );

    expect(screen.getByTestId("schedule-flow-step-open").dataset.active).toBe(
      "true",
    );
    expect(screen.queryByTestId("schedule-flow-step-inputs")).toBeNull();
    expect(screen.getByTestId("schedule-flow-step-availability")).toBeTruthy();

    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(screen.getByTestId("schedule-flow-body-recurrence")).toBeTruthy();

    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(screen.getByTestId("schedule-flow-body-availability")).toBeTruthy();

    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(onSave).toHaveBeenCalled();
  });

  it("includes inputs when fields exist and blocks continue until required filled", () => {
    const onSave = mock(() => undefined);
    let values: Record<string, unknown> = {};
    const { rerender } = render(
      <ScheduleFlow
        entry={{
          ...baseEntry,
          kind: "last30days-research",
          allowedScopes: ["personal"],
          intakeFields: topicFields,
        }}
        productLabel="Research"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={values}
        onFieldValuesChange={(next) => {
          values = next;
        }}
        fields={topicFields}
        error={null}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // open → recurrence
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // recurrence → inputs
    expect(screen.getByTestId("schedule-flow-body-inputs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(screen.getByText("Fill in the required fields.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Topic/), {
      target: { value: "AI agents" },
    });
    values = { topic: "AI agents" };
    rerender(
      <ScheduleFlow
        entry={{
          ...baseEntry,
          kind: "last30days-research",
          allowedScopes: ["personal"],
          intakeFields: topicFields,
        }}
        productLabel="Research"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={values}
        onFieldValuesChange={(next) => {
          values = next;
        }}
        fields={topicFields}
        error={null}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(onSave).toHaveBeenCalled();
  });

  it("round-trips a sub-hourly interval selection through save and back into the editor (CL-4278)", () => {
    const onSave = mock(() => undefined);

    function Harness({ persisted }: { persisted: ScheduleRecurrence }) {
      const [recurrence, setRecurrence] = useState(persisted);
      return (
        <ScheduleFlow
          entry={baseEntry}
          productLabel="Gamma"
          recurrence={recurrence}
          onRecurrenceChange={setRecurrence}
          scope="personal"
          onScopeChange={() => undefined}
          fieldValues={{}}
          onFieldValuesChange={() => undefined}
          fields={[]}
          error={null}
          onCancel={() => undefined}
          onSave={onSave}
        />
      );
    }

    const { rerender } = render(<Harness key="a" persisted={daily} />);

    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // open → recurrence

    const unitSelect = screen.getByLabelText("Interval unit");
    fireEvent.change(unitSelect, { target: { value: "minutes" } });
    const amountInput = screen.getByLabelText("How often") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "5" } });

    expect(amountInput.value).toBe("5");
    expect((unitSelect as HTMLSelectElement).value).toBe("minutes");

    const saved: ScheduleRecurrence = {
      intervalMinutes: 5,
      anchorMinuteUtc: 14 * 60,
    };

    // Reopen: a fresh mount with the saved recurrence must select the same
    // amount/unit back into the controls.
    rerender(<Harness key="b" persisted={saved} />);
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // open → recurrence
    expect((screen.getByLabelText("How often") as HTMLInputElement).value).toBe(
      "5",
    );
    expect(
      (screen.getByLabelText("Interval unit") as HTMLSelectElement).value,
    ).toBe("minutes");
    expect(screen.getByText(/Every 5 minutes, starting at/)).toBeTruthy();
  });

  it("locks the interval control to Once a day for a daily-only kind (heartbeat)", () => {
    render(
      <ScheduleFlow
        entry={{
          ...baseEntry,
          kind: "heartbeat",
          allowedScopes: ["personal"],
        }}
        productLabel="Morning brief"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("schedule-flow-primary")); // open → recurrence
    expect(screen.getByTestId("recurrence-daily-only-heartbeat")).toBeTruthy();
    expect(screen.queryByLabelText("Interval unit")).toBeNull();
  });

  it("collapses availability on edit", () => {
    render(
      <ScheduleFlow
        entry={baseEntry}
        productLabel="Gamma"
        existing={{ scope: "tenant" }}
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="tenant"
        onScopeChange={() => undefined}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.queryByTestId("schedule-flow-step-availability")).toBeNull();
    expect(screen.getByText(/Editing schedule/)).toBeTruthy();
  });
});
