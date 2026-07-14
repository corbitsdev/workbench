import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

mock.module("framer-motion", () => ({
  motion: {
    span: ({
      children,
      className,
    }: {
      children?: React.ReactNode;
      className?: string;
    }) => React.createElement("span", { className }, children),
  },
  useReducedMotion: () => true,
  useSpring: (value: number) => ({ get: () => value, set: () => {} }),
  useTransform: (mv: { get: () => number }, fn: (v: number) => string) =>
    fn(mv.get()),
}));

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
    const { container } = render(
      <Pagination page={2} totalPages={4} total={87} onPageChange={() => {}} />,
    );
    expect(container.textContent).toMatch(/Page 2 of 4/);
    expect(container.textContent).toMatch(/87 total/);
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
