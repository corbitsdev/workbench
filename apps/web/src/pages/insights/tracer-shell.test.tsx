/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { CopyId, TracerFacetNav, type FacetDef } from "./tracer-shell";

function renderNav(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

afterEach(() => {
  cleanup();
});

describe("CopyId", () => {
  it("writes the id to the clipboard and shows a confirmation state", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CopyId id="run_abc123" />);
    const button = screen.getByRole("button", { name: "Copy ID" });

    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("run_abc123");
    });
    await waitFor(() => {
      expect(button.querySelector("svg.text-green")).not.toBeNull();
    });
  });

  it("does not enter the confirmation state when the clipboard write fails", async () => {
    const writeText = mock(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CopyId id="run_fail" />);
    const button = screen.getByRole("button", { name: "Copy ID" });

    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("run_fail");
    });
    expect(button.querySelector("svg.text-green")).toBeNull();
  });
});

describe("TracerFacetNav", () => {
  const facets: FacetDef[] = [
    { id: "timeline", label: "Timeline", hasGap: false },
    { id: "cost", label: "Cost", hasGap: true },
  ];

  it("disables previous on the first facet and next on the last", () => {
    const onChange = mock(() => {});
    const { rerender } = renderNav(
      <TracerFacetNav
        backTo="/insights"
        facets={facets}
        activeIndex={0}
        onFacetIndexChange={onChange}
      />,
    );

    const prevBtn = screen.getByRole("button", {
      name: "Previous facet",
    }) as HTMLButtonElement;
    const nextBtn = screen.getByRole("button", {
      name: "Next facet",
    }) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
    fireEvent.click(nextBtn);
    expect(onChange).toHaveBeenCalledWith(1);

    rerender(
      <MemoryRouter>
        <TracerFacetNav
          backTo="/insights"
          facets={facets}
          activeIndex={1}
          onFacetIndexChange={onChange}
        />
      </MemoryRouter>,
    );
    expect(
      (screen.getByRole("button", { name: "Next facet" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
