/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ChangelogRelease } from "@workbench/shared";
import { WhatsNewDialog } from "./WhatsNewDialog";

const release: ChangelogRelease = {
  version: "0.6.0",
  date: "2026-07-11",
  title: "Test release",
  entries: [
    {
      title: "Feature one",
      description: "Description one.",
      to: "/inbox",
    },
    {
      title: "Feature two",
      description: "Description two.",
    },
  ],
};

function renderDialog(onClose = mock(() => {}), onDone = mock(() => {})) {
  render(
    <MemoryRouter>
      <WhatsNewDialog release={release} onClose={onClose} onDone={onDone} />
    </MemoryRouter>,
  );
  return { onClose, onDone };
}

afterEach(() => {
  cleanup();
});

describe("WhatsNewDialog", () => {
  it("renders every entry's title and description", () => {
    renderDialog();
    screen.getByText("Feature one");
    screen.getByText("Description one.");
    screen.getByText("Feature two");
    screen.getByText("Description two.");
  });

  it("renders 'Take me there' only for entries with a route", () => {
    renderDialog();
    expect(screen.getAllByText("Take me there").length).toBe(1);
  });

  it("Done calls onDone and onClose", () => {
    const { onClose, onDone } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone.mock.calls.length).toBe(1);
    expect(onClose.mock.calls.length).toBe(1);
  });

  it("Escape closes without calling onDone", () => {
    const { onClose, onDone } = renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose.mock.calls.length).toBe(1);
    expect(onDone.mock.calls.length).toBe(0);
  });

  it("clicking the close button closes without calling onDone", () => {
    const { onClose, onDone } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose.mock.calls.length).toBe(1);
    expect(onDone.mock.calls.length).toBe(0);
  });

  it("Tab from the last focusable element wraps to the first", () => {
    renderDialog();
    const closeButton = screen.getByRole("button", { name: "Close" });
    const doneButton = screen.getByRole("button", { name: "Done" });
    doneButton.focus();
    expect(document.activeElement).toBe(doneButton);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
  });

  it("Shift+Tab from the first focusable element wraps to the last", () => {
    renderDialog();
    const closeButton = screen.getByRole("button", { name: "Close" });
    const doneButton = screen.getByRole("button", { name: "Done" });
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Tab",
      shiftKey: true,
    });
    expect(document.activeElement).toBe(doneButton);
  });

  it("locks and restores body scroll while mounted", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <MemoryRouter>
        <WhatsNewDialog
          release={release}
          onClose={() => {}}
          onDone={() => {}}
        />
      </MemoryRouter>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("clicking 'Take me there' calls onClose", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByText("Take me there"));
    expect(onClose.mock.calls.length).toBe(1);
  });

  it("restores focus to the trigger element on unmount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <MemoryRouter>
        <WhatsNewDialog
          release={release}
          onClose={() => {}}
          onDone={() => {}}
        />
      </MemoryRouter>,
    );
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
