/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";
import type { NowTaskItem, Task, TaskLink } from "@workbench/shared";

mock.module("./TaskAssigneePicker", () => ({
  TaskAssigneePicker: () => null,
}));
mock.module("./TaskSendToAdapter", () => ({
  TaskSendToAdapter: () => null,
}));

const { NowSection } = require("./NowSection");

afterEach(() => {
  cleanup();
});

function makeTask(links: TaskLink[], over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    createdByPrincipalId: "principal-1",
    title: "Follow up with Acme",
    status: "open",
    source: "user",
    links,
    externalRefs: [],
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z",
    ...over,
  };
}

function renderNow(task: Task) {
  const item: NowTaskItem = { type: "task", task };
  render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NowSection, {
        items: [item],
        ready: true,
        reduceMotion: true,
      }),
    ),
  );
}

describe("NowSection taskHref resolution", () => {
  it("resolves a workflow_run link to /workflows/:ref", () => {
    renderNow(makeTask([{ kind: "workflow_run", ref: "run-1" }]));
    const link = screen.getByText("Follow up with Acme").closest("a");
    expect(link?.getAttribute("href")).toBe("/workflows/run-1");
  });

  it("resolves a mail link to /inbox/:ref", () => {
    renderNow(makeTask([{ kind: "mail", ref: "mail-1" }]));
    const link = screen.getByText("Follow up with Acme").closest("a");
    expect(link?.getAttribute("href")).toBe("/inbox/mail-1");
  });

  it("resolves an artifact link to /artifacts/:ref", () => {
    renderNow(makeTask([{ kind: "artifact", ref: "artifact-1" }]));
    const link = screen.getByText("Follow up with Acme").closest("a");
    expect(link?.getAttribute("href")).toBe("/artifacts/artifact-1");
  });

  it("resolves a conversation link to /chats/:ref", () => {
    renderNow(makeTask([{ kind: "conversation", ref: "thread-1" }]));
    const link = screen.getByText("Follow up with Acme").closest("a");
    expect(link?.getAttribute("href")).toBe("/chats/thread-1");
  });

  it("resolves a url link to the raw external ref and marks it external", () => {
    renderNow(makeTask([{ kind: "url", ref: "https://example.com/doc" }]));
    const link = screen.getByText("Follow up with Acme").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/doc");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders no link at all as a non-interactive row rather than crashing", () => {
    renderNow(makeTask([]));
    const title = screen.getByText("Follow up with Acme");
    expect(title.closest("a")).toBeNull();
  });

  it("surfaces every link, not just the first", () => {
    renderNow(
      makeTask([
        { kind: "workflow_run", ref: "run-1" },
        { kind: "url", ref: "https://example.com/doc", label: "Source doc" },
        { kind: "conversation", ref: "thread-2" },
      ]),
    );
    const primary = screen.getByText("Follow up with Acme").closest("a");
    expect(primary?.getAttribute("href")).toBe("/workflows/run-1");

    const extraUrl = screen.getByText("Source doc");
    expect(extraUrl.getAttribute("href")).toBe("https://example.com/doc");

    const extraConversation = screen.getByText("Conversation");
    expect(extraConversation.getAttribute("href")).toBe("/chats/thread-2");
  });
});
