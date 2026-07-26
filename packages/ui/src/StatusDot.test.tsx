/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import StatusDot from "./StatusDot";

afterEach(() => {
  cleanup();
  mockReducedMotion.current = false;
});

const mockReducedMotion = { current: false };
const MOTION_ONLY = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
]);
function motionMock(tag: string) {
  return ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (!MOTION_ONLY.has(key)) domProps[key] = value;
    }
    return React.createElement(tag, domProps, children);
  };
}
mock.module("framer-motion", () => ({
  motion: { div: motionMock("div"), span: motionMock("span") },
  useReducedMotion: () => mockReducedMotion.current,
}));

describe("StatusDot", () => {
  it("renders a pulsing ring (via the shared PulsingRing primitive) when pulsing is true", () => {
    const { container } = render(
      <StatusDot colorClassName="bg-blue" pulsing />,
    );
    expect(container.querySelector(".bg-blue\\/60")).not.toBeNull();
  });

  it("renders no pulsing ring when pulsing is false (terminal states stay static)", () => {
    const { container } = render(
      <StatusDot colorClassName="bg-green" pulsing={false} />,
    );
    expect(container.querySelector(".bg-green\\/60")).toBeNull();
  });

  it("falls back to a static dot under reduced motion, even while pulsing (CL-2755: never fully invisible)", () => {
    mockReducedMotion.current = true;
    const { container } = render(
      <StatusDot colorClassName="bg-blue" pulsing />,
    );
    expect(container.querySelector(".bg-blue\\/60")).toBeNull();
    expect(container.querySelector(".bg-blue")).not.toBeNull();
  });

  it("resolves the ring class to a pre-written literal for every mapped color, not a runtime-concatenated string", () => {
    for (const color of [
      "bg-blue",
      "bg-green",
      "bg-orange",
      "bg-red",
      "bg-text-3",
    ]) {
      const { container } = render(
        <StatusDot colorClassName={color} pulsing />,
      );
      expect(container.querySelector(`.${color}\\/60`)).not.toBeNull();
      cleanup();
    }
  });

  it("fails loudly when asked to pulse with an unmapped colorClassName", () => {
    expect(() =>
      render(<StatusDot colorClassName="bg-purple" pulsing />),
    ).toThrow(/no pulsing-ring class mapped/);
  });
});
