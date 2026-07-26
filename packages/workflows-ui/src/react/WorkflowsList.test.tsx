/// <reference types="bun" />
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkflowListItem } from "./types";
import { WorkflowsList } from "./WorkflowsList";

afterEach(() => {
  cleanup();
});

const live: WorkflowListItem[] = [
  {
    id: "run_1",
    itemKind: "run",
    title: "Last 30 days",
    subtitle: "Manual run",
    when: "Manual run",
    scope: "personal",
    statusTone: "awaiting",
    statusLabel: "Needs you",
    nextOrElapsed: "2:14",
    needsYou: true,
  },
];

const scheduled: WorkflowListItem[] = [
  {
    id: "sched_1",
    itemKind: "schedule",
    title: "Granola digest",
    subtitle: "Morning",
    when: "Weekdays 07:30",
    scope: "tenant",
    statusTone: "running",
    statusLabel: "Active",
    nextOrElapsed: "in 3h",
    nextSoon: true,
  },
];

describe("WorkflowsList", () => {
  test("renders Live and Scheduled sections with counts", () => {
    render(
      <WorkflowsList
        live={live}
        scheduled={scheduled}
        selectedId="run_1"
        selectedKind="run"
      />,
    );
    expect(screen.getByText("Live · 1")).toBeTruthy();
    expect(screen.getByText("Scheduled · 1")).toBeTruthy();
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    expect(screen.getByText("Granola digest")).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  test("invokes onSelect when a row is clicked", () => {
    const onSelect = mock((_item: WorkflowListItem) => {});
    render(
      <WorkflowsList live={live} scheduled={scheduled} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText("Granola digest"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({
      id: "sched_1",
      itemKind: "schedule",
    });
  });

  test("renders empty state when no rows", () => {
    render(<WorkflowsList live={[]} scheduled={[]} />);
    expect(screen.getByText("No workflows match these filters.")).toBeTruthy();
  });
});
