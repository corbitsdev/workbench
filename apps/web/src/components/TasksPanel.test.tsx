/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type { Task } from "@workbench/shared";
import { ApiError } from "../lib/api";

const mutateCalls: unknown[] = [];
const bulkCalls: unknown[] = [];
let bulkReject: unknown = null;

mock.module("../hooks/use-task-mutations", () => ({
  useUpdateTaskStatus: () => ({
    mutate: (vars: unknown) => mutateCalls.push(vars),
    mutateAsync: async (vars: unknown) => {
      mutateCalls.push(vars);
      return vars;
    },
    isPending: false,
  }),
  useBulkUpdateTaskStatus: () => ({
    mutate: (vars: unknown) => bulkCalls.push(vars),
    mutateAsync: async (vars: unknown) => {
      bulkCalls.push(vars);
      if (bulkReject) throw bulkReject;
      return { updated: 1, ids: [] };
    },
    isPending: false,
  }),
}));

const { TasksPanel } = require("./TasksPanel");

afterEach(() => {
  cleanup();
  mutateCalls.length = 0;
  bulkCalls.length = 0;
  bulkReject = null;
});

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-a",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    createdByPrincipalId: "principal-1",
    title: "Ship v0.6",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z",
    ...over,
  };
}

describe("TasksPanel", () => {
  it("renders open tasks sorted by urgency", () => {
    render(
      React.createElement(TasksPanel, {
        tasks: [
          makeTask({ id: "w", title: "Waiting one", status: "waiting" }),
          makeTask({ id: "p", title: "In progress", status: "in_progress" }),
        ],
      }),
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("In progress");
    expect(rows[2]?.textContent).toContain("Waiting one");
  });

  it("renders task.body under the title", () => {
    render(
      React.createElement(TasksPanel, {
        tasks: [makeTask({ body: "Follow up with design" })],
      }),
    );
    expect(screen.getByText("Follow up with design")).toBeTruthy();
  });

  it("bulk dismiss sends cancelled status for selected rows", async () => {
    render(
      React.createElement(TasksPanel, {
        tasks: [
          makeTask({ id: "task-a" }),
          makeTask({ id: "task-b", title: "B" }),
        ],
      }),
    );
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await Promise.resolve();
    expect(bulkCalls[0]).toEqual({
      ids: ["task-a"],
      status: "cancelled",
    });
  });

  it("surfaces bulk mutation errors like inbox", async () => {
    bulkReject = new ApiError("Couldn't save", 500);
    render(
      React.createElement(TasksPanel, {
        tasks: [makeTask({ id: "task-a" })],
      }),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save");
  });
});
