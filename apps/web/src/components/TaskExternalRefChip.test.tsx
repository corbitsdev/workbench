/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import type { TaskExternalRef } from "@workbench/shared";

import { TaskExternalRefChip } from "./TaskExternalRefChip";

afterEach(cleanup);

function renderChip(externalRef: TaskExternalRef) {
  render(React.createElement(TaskExternalRefChip, { externalRef }));
}

describe("TaskExternalRefChip", () => {
  it("renders a linked chip for a synced ref", () => {
    renderChip({
      adapterId: "attio",
      externalId: "ext-1",
      syncState: "synced",
    });
    screen.getByText("Attio");
  });

  it("links out to the external URL when one is present", () => {
    renderChip({
      adapterId: "linear",
      externalId: "ext-2",
      externalUrl: "https://linear.app/issue/ext-2",
      syncState: "synced",
    });
    const link = screen.getByRole("link", { name: "Linear" });
    expect(link.getAttribute("href")).toBe("https://linear.app/issue/ext-2");
  });

  it("renders a sending chip for a pending ref", () => {
    renderChip({
      adapterId: "attio",
      externalId: "ext-3",
      syncState: "pending",
    });
    screen.getByText("Attio · sending");
  });

  it("never renders an error/failed state for an errored-but-pending ref", () => {
    // The push service folds a failed push back into `pending` at the server
    // boundary — there is no `failed` syncState. This asserts the chip layer
    // holds that line too: a pending ref renders only as "sending", never
    // surfacing any error/failure text.
    renderChip({
      adapterId: "attio",
      externalId: "ext-4",
      syncState: "pending",
    });
    expect(screen.queryByText(/error/i)).toBeNull();
    expect(screen.queryByText(/fail/i)).toBeNull();
  });

  it("renders nothing for a detached ref", () => {
    const { container } = render(
      React.createElement(TaskExternalRefChip, {
        externalRef: {
          adapterId: "attio",
          externalId: "ext-5",
          syncState: "detached",
        },
      }),
    );
    expect(container.textContent).toBe("");
  });
});
