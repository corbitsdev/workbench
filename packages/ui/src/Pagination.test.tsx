import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Pagination } from "./Pagination";

afterEach(cleanup);

describe("Pagination", () => {
  it("renders nothing when there is a single page", () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} total={5} onPageChange={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows the current page, total pages, and total count", () => {
    render(
      <Pagination page={2} totalPages={4} total={87} onPageChange={() => {}} />,
    );
    expect(screen.getByText(/Page 2 of 4/).textContent).toContain(
      "Page 2 of 4",
    );
    expect(screen.getByText(/87 total/).textContent).toContain("87 total");
  });

  it("advances/retreats by one page via Next/Previous", () => {
    const onPageChange = mock((_page: number) => {});
    render(
      <Pagination
        page={2}
        totalPages={4}
        total={87}
        onPageChange={onPageChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange.mock.calls[0]?.[0]).toBe(3);
    expect(onPageChange.mock.calls[1]?.[0]).toBe(1);
  });

  it("disables Previous on the first page and Next on the last", () => {
    const { rerender } = render(
      <Pagination page={1} totalPages={3} total={60} onPageChange={() => {}} />,
    );
    expect(
      (screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(
      <Pagination page={3} totalPages={3} total={60} onPageChange={() => {}} />,
    );
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
