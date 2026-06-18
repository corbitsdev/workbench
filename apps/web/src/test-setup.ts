import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import React from 'react';

GlobalRegistrator.register();

// Happy DOM defaults to about:blank, leaving window.location.origin empty so any
// code that resolves a same-origin URL (e.g. buildApiUrl's `new URL(path, origin)`)
// throws "Invalid URL" at render time. Set a concrete origin once for all tests.
(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
  'http://localhost/'
);

// framer-motion is not compatible with Happy DOM. Provide a complete mock here
// (rather than per-test partial mocks of motion.div) so the mock is registered
// once before any test file evaluates its component imports. Per-file partial
// mocks leaked across files under bun: a file mocking only motion.div poisoned a
// later file that used motion.button/AnimatePresence, because bun evaluates all
// test-file top-level imports before running tests, so an afterAll restore runs
// too late. A single complete mock removes that whole class of leakage.
const motionOnlyProps = [
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileInView',
  'layout',
  'layoutId',
  'drag',
  'viewport',
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
  }
);

// Exported so tests that call mock.restore() (which clears every module mock,
// including this one) can re-register framer-motion afterwards and avoid
// poisoning later files that render motion components.
export function registerFramerMotionMock(): void {
  mock.module('framer-motion', () => ({
    motion: motionProxy,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }));
}

registerFramerMotionMock();
