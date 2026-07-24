/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  CreateScheduleFormLayout,
  CreateScheduleSummary,
} from "./CreateScheduleFormLayout";
import { InspectorEmpty, InspectorShell } from "./InspectorShell";
import { KindPickerShell } from "./KindPicker";
import { LiveRunInspector } from "./LiveRunInspector";
import { ScheduleInspectorView } from "./ScheduleInspector";

afterEach(() => {
  cleanup();
});

describe("InspectorShell", () => {
  test("renders empty state when only empty is provided", () => {
    render(
      <InspectorShell
        empty={
          <InspectorEmpty
            title="Select a workflow"
            description="Click a row to review details."
          />
        }
      />,
    );
    expect(screen.getByText("Select a workflow")).toBeTruthy();
    expect(screen.getByText("Click a row to review details.")).toBeTruthy();
  });
});

describe("LiveRunInspector", () => {
  test("renders phase chip, banner, and run meta", () => {
    render(
      <LiveRunInspector
        phase="running"
        scope="personal"
        title="Last 30 days"
        description="Research digest"
        elapsed="1:02"
        started="just now"
        origin="Manual run"
        kindSlug="last30days-research"
        runId="run_abc"
        steps={[
          { id: "s1", name: "Start", status: "done" },
          { id: "s2", name: "Work", status: "active" },
        ]}
      />,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    expect(screen.getByText(/Running · right-side live status/)).toBeTruthy();
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByText("run_abc")).toBeTruthy();
  });
});

describe("ScheduleInspectorView", () => {
  test("renders overview blocks", () => {
    render(
      <ScheduleInspectorView
        enabled
        scope="tenant"
        title="Granola digest"
        cadence="Weekdays 07:30"
        next="in 3h"
        last="Today 07:30"
        name="Morning"
        kindSlug="granola-call"
        scheduleId="sched_1"
      />,
    );
    expect(screen.getByText("Active")).toBeTruthy();
    // Scope appears in the header pill and the Scope read-block.
    expect(screen.getAllByText("Everyone").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Weekdays 07:30")).toBeTruthy();
    expect(screen.getByText("Morning")).toBeTruthy();
    expect(screen.getByText("Granola digest")).toBeTruthy();
  });
});

describe("KindPickerShell", () => {
  test("renders kind cards", () => {
    render(
      <KindPickerShell
        items={[
          {
            id: "k1",
            label: "Last 30 days",
            description: "Research digest",
            category: "research",
            categoryLabel: "Research",
            alreadyOn: true,
          },
        ]}
        selectedId="k1"
      />,
    );
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    expect(screen.getByText("Already on")).toBeTruthy();
  });
});

describe("CreateScheduleFormLayout", () => {
  test("renders form and sticky summary", () => {
    render(
      <CreateScheduleFormLayout
        form={<div>Form fields</div>}
        summary={
          <CreateScheduleSummary
            rows={[
              { label: "Kind", value: "Last 30 days" },
              { label: "Cadence", value: "Daily 9:00" },
            ]}
          />
        }
      />,
    );
    expect(screen.getByText("Form fields")).toBeTruthy();
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    expect(screen.getByText("Daily 9:00")).toBeTruthy();
  });
});
