import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LibraryPageHeader, LibrarySearchInput } from "./LibraryPageHeader";

afterEach(cleanup);

describe("LibraryPageHeader", () => {
  it("renders the title as a level-1 heading", () => {
    render(<LibraryPageHeader title="Skills" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Skills" }),
    ).toBeTruthy();
  });

  it("renders a count badge only when count is provided", () => {
    const { rerender } = render(<LibraryPageHeader title="Tools" count={7} />);
    expect(screen.getByText("7 items")).toBeTruthy();

    rerender(<LibraryPageHeader title="Tools" />);
    expect(screen.queryByText(/items/)).toBeNull();
  });

  it("uses tokenized title sizing rather than verbatim arbitrary values", () => {
    const { rerender } = render(<LibraryPageHeader title="Skills" />);
    const lg = screen.getByRole("heading", { level: 1, name: "Skills" });
    expect(lg.className).toContain("text-library-title");
    expect(lg.className).not.toContain("text-[21px]");

    rerender(<LibraryPageHeader title="Chats" titleSize="sm" />);
    const sm = screen.getByRole("heading", { level: 1, name: "Chats" });
    expect(sm.className).toContain("text-library-title-sm");
    expect(sm.className).not.toContain("text-[17px]");
  });

  it("wraps so trailing controls reflow below the title on narrow viewports", () => {
    render(<LibraryPageHeader title="Skills" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.closest(".flex-wrap")).toBeTruthy();
  });

  it("renders action children on the trailing edge", () => {
    render(
      <LibraryPageHeader title="Skills">
        <button type="button">Add skill</button>
      </LibraryPageHeader>,
    );
    expect(screen.getByRole("button", { name: "Add skill" })).toBeTruthy();
  });
});

describe("LibrarySearchInput", () => {
  it("is a controlled search input that reports raw values to onChange", () => {
    let captured = "";
    render(
      <LibrarySearchInput
        label="Search skills"
        placeholder="Search skills"
        value=""
        onChange={(v) => {
          captured = v;
        }}
      />,
    );
    const input = screen.getByLabelText("Search skills") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("search");
    expect(input.getAttribute("placeholder")).toBe("Search skills");
    fireEvent.change(input, { target: { value: "asap" } });
    expect(captured).toBe("asap");
  });

  it("reflects the controlled value", () => {
    render(
      <LibrarySearchInput
        label="Search tools"
        value="linear"
        onChange={() => {}}
      />,
    );
    expect(
      (screen.getByLabelText("Search tools") as HTMLInputElement).value,
    ).toBe("linear");
  });

  it("applies the ghost variant classes when requested", () => {
    render(
      <LibrarySearchInput
        label="Search chats"
        value=""
        onChange={() => {}}
        variant="ghost"
      />,
    );
    const input = screen.getByLabelText("Search chats");
    expect(input.className).toContain("border-transparent");
    expect(input.className).not.toContain("rounded-[9px]");
  });

  it("defaults to the bordered variant with a tokenized radius", () => {
    render(
      <LibrarySearchInput label="Search tools" value="" onChange={() => {}} />,
    );
    const input = screen.getByLabelText("Search tools");
    expect(input.className).toContain("border-border");
    expect(input.className).toContain("rounded-input");
    expect(input.className).not.toContain("rounded-[9px]");
  });
});
