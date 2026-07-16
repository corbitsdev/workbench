/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import React from "react";
import { ChatThreadInfoDialog } from "./ChatThreadInfoDialog";

afterEach(() => cleanup());

function renderDialog(
  props: Partial<React.ComponentProps<typeof ChatThreadInfoDialog>> = {},
) {
  return render(
    <MemoryRouter>
      <ChatThreadInfoDialog
        open
        onClose={() => {}}
        title="Roadmap planning"
        instanceId="inst_123"
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("ChatThreadInfoDialog", () => {
  it("renders nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the thread title, instance id, and only the fields provided", () => {
    renderDialog({
      agentName: "Myra",
      mailAddress: "myra-inst_123@workbench.local",
      createdAt: "2026-01-01T12:00:00Z",
      status: "active",
    });
    expect(screen.getByText("Roadmap planning")).toBeDefined();
    expect(screen.getByText("inst_123")).toBeDefined();
    expect(screen.getByText("Myra")).toBeDefined();
    expect(
      screen.getByText("myra-inst_123@workbench.local"),
    ).toBeDefined();
    expect(screen.getByText("active")).toBeDefined();
    // A field with no data supplied (model) never appears, even as a placeholder.
    expect(screen.queryByText("Model")).toBeNull();
  });

  it("omits agent name, mail address, created time, and status when absent from the payload", () => {
    renderDialog();
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("Mail address")).toBeNull();
    expect(screen.queryByText("Created")).toBeNull();
    expect(screen.queryByText("Status")).toBeNull();
    // Instance ID always renders — it's the one field guaranteed present.
    expect(screen.getByText("inst_123")).toBeDefined();
  });

  it("links Open trace to the supplied href", () => {
    renderDialog({ traceHref: "/insights/trace/run_1" });
    expect(
      screen.getByRole("link", { name: "Open trace" }).getAttribute("href"),
    ).toBe("/insights/trace/run_1");
  });

  it("omits Open trace when no href is resolvable", () => {
    renderDialog();
    expect(screen.queryByRole("link", { name: "Open trace" })).toBeNull();
  });

  it("always links View in Agents to the Agents page", () => {
    renderDialog();
    expect(
      screen.getByRole("link", { name: "View in Agents" }).getAttribute("href"),
    ).toBe("/agents");
  });

  it("closes on the close button and on Escape", () => {
    let closed = 0;
    renderDialog({ onClose: () => closed++ });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closed).toBe(1);
  });
});
