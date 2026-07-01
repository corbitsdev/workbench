/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router";

let artifactsResult: {
  data?: { id: string; kind: string; title: string }[];
  isLoading: boolean;
  isError: boolean;
};

const openWithMessage = mock((_message: string) => {});

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: "tenant-1" }),
}));
mock.module("../lib/chat-launcher-context", () => ({
  useChatLauncher: () => ({ openWithMessage }),
}));
mock.module("@workbench/client/react", () => ({
  useArtifacts: () => artifactsResult,
  useTenantMembers: () => ({ data: [] }),
}));
mock.module("../components/ArtifactBody", () => ({
  default: (props: { artifact: { title: string } }) =>
    React.createElement("div", { "data-testid": "body" }, props.artifact.title),
}));

const { ArtifactDetailPage } = require("./ArtifactDetailPage");

function renderAt(id: string) {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/artifacts/${id}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: "/artifacts/:artifactId",
          element: React.createElement(ArtifactDetailPage),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  artifactsResult = {
    data: [{ id: "art-1", kind: "one-pager", title: "Acme One-Pager" }],
    isLoading: false,
    isError: false,
  };
  openWithMessage.mockClear();
});
afterEach(() => cleanup());

describe("ArtifactDetailPage", () => {
  it("renders the artifact full-page", () => {
    renderAt("art-1");
    expect(
      screen.getByRole("heading", { name: "Acme One-Pager" }),
    ).toBeDefined();
    expect(screen.getByTestId("body").textContent).toBe("Acme One-Pager");
  });

  it("shows a not-found state for an unknown id", () => {
    renderAt("does-not-exist");
    screen.getByText(/couldn't be found/i);
  });

  it("does not render the in-pane chat composer (Myra lives in the dock)", () => {
    renderAt("art-1");
    expect(
      screen.queryByPlaceholderText(/ask myra about this artifact/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /start chat/i })).toBeNull();
  });

  it("opens the dock seeded with the artifact when 'Chat about this artifact' is clicked", () => {
    renderAt("art-1");
    fireEvent.click(
      screen.getByRole("button", { name: /chat about this artifact/i }),
    );
    expect(openWithMessage).toHaveBeenCalledTimes(1);
    const message = openWithMessage.mock.calls[0][0];
    expect(message).toContain("art-1");
    expect(message).toContain("Acme One-Pager");
    expect(message).toContain("tenant-1");
    expect(message).toContain("artifact_read");
  });
});
