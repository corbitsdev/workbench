/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

let reducedMotion = false;
const springSet = mock((_v: number) => {});

mock.module("framer-motion", () => ({
  motion: {
    span: ({
      children,
      className,
    }: {
      children?: React.ReactNode;
      className?: string;
    }) => React.createElement("span", { className, "data-motion": "true" }, children),
  },
  useReducedMotion: () => reducedMotion,
  useSpring: (value: number) => {
    springSet(value);
    return { get: () => value, set: springSet };
  },
  useTransform: (_mv: unknown, fn: (v: number) => string) => fn(7),
}));

import { AnimatedNumber } from "./AnimatedNumber";

afterEach(() => {
  cleanup();
  reducedMotion = false;
});

describe("AnimatedNumber", () => {
  it("renders tabular-nums and formatted value when motion reduced", () => {
    reducedMotion = true;
    render(<AnimatedNumber value={1200} format={(n) => `$${Math.round(n)}`} />);
    const el = screen.getByText("$1200");
    expect(el.className).toContain("tabular-nums");
    expect(el.getAttribute("data-motion")).toBeNull();
  });

  it("uses motion span when reduced motion is off", () => {
    reducedMotion = false;
    render(<AnimatedNumber value={7} decimals={0} />);
    const el = screen.getByText("7");
    expect(el.getAttribute("data-motion")).toBe("true");
    expect(el.className).toContain("tabular-nums");
  });

  it("updates spring target when value changes", () => {
    reducedMotion = false;
    const { rerender } = render(<AnimatedNumber value={1} />);
    rerender(<AnimatedNumber value={99} />);
    expect(springSet.mock.calls.some((c) => c[0] === 99)).toBe(true);
  });
});