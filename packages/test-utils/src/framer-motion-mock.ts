import { mock } from "bun:test";
import React from "react";

const motionOnlyProps = [
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "whileHover",
  "whileTap",
  "whileInView",
  "layout",
  "layoutId",
  "drag",
  "viewport",
];

const motionComponentCache = new Map<string, React.FunctionComponent>();

const motionProxy = new Proxy(
  {},
  {
    get(_target, tag: string) {
      const cached = motionComponentCache.get(tag);
      if (cached) {
        return cached;
      }
      const Component: React.FunctionComponent<{
        children?: React.ReactNode;
        [key: string]: unknown;
      }> = ({ children, ...rest }) => {
        const domProps: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rest)) {
          if (!motionOnlyProps.includes(key)) {
            domProps[key] = value;
          }
        }
        return React.createElement(tag, domProps, children);
      };
      motionComponentCache.set(tag, Component);
      return Component;
    },
  },
);

function createMotionValue(initial: unknown) {
  let current = initial;
  return {
    get: () => current,
    set: (next: unknown) => {
      current = next;
    },
    on: () => () => {},
    destroy: () => {},
  };
}

export function registerFramerMotionMock(): void {
  mock.module("framer-motion", () => ({
    motion: motionProxy,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
    useMotionValue: (initial: unknown) => createMotionValue(initial),
    useSpring: (initial: unknown) => createMotionValue(initial),
    useTransform: () => createMotionValue(0),
  }));
}
