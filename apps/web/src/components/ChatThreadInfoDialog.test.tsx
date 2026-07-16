/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      status: "Active",
    });
    screen.getByText("Roadmap planning");
    screen.getByText("inst_123");
    screen.getByText("Myra");
    screen.getByText("myra-inst_123@workbench.local");
    screen.getByText("Active");
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
    screen.getByText("inst_123");
  });

  it("copies the instance id to the clipboard and shows a brief Copied state", async () => {
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Copy instance ID" }));
    expect(writeText).toHaveBeenCalledWith("inst_123");
    await waitFor(() => screen.getByText("Copied"));
  });

  it("links Open trace to the supplied href", () => {
    renderDialog({ traceHref: "/insights/users/p1" });
    expect(
      screen.getByRole("link", { name: "Open trace" }).getAttribute("href"),
    ).toBe("/insights/users/p1");
  });

  it("omits Open trace when no href is resolvable", () => {
    renderDialog();
    expect(screen.queryByRole("link", { name: "Open trace" })).toBeNull();
  });

  it("always links Open Agents page to the Agents page", () => {
    renderDialog();
    expect(
      screen
        .getByRole("link", { name: "Open Agents page" })
        .getAttribute("href"),
    ).toBe("/agents");
  });

  it("closes on the close button", () => {
    let closed = 0;
    renderDialog({ onClose: () => closed++ });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closed).toBe(1);
  });

  it("closes on Escape", () => {
    let closed = 0;
    renderDialog({ onClose: () => closed++ });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(closed).toBe(1);
  });

  it("closes on a backdrop click but not on a click inside the panel", () => {
    let closed = 0;
    renderDialog({ onClose: () => closed++ });
    fireEvent.click(screen.getByText("Roadmap planning"));
    expect(closed).toBe(0);
    fireEvent.click(screen.getByRole("dialog"));
    expect(closed).toBe(1);
  });

  it("wraps focus from the last focusable element back to the first on Tab", () => {
    renderDialog({ traceHref: "/insights/users/p1" });
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("wraps focus from the first focusable element back to the last on Shift+Tab", () => {
    renderDialog({ traceHref: "/insights/users/p1" });
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
