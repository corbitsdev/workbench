import { afterEach, describe, expect, test } from "bun:test";

import {
  isAdditiveSelectClick,
  isRowActivationKey,
  rowActivationProps,
} from "./activatable-row";

// `isAdditiveSelectClick`'s Mac/non-Mac branch reads `navigator.platform`,
// which happy-dom's `GlobalRegistrator` reports as whatever the *host* OS
// is — Darwin-flavored on a Mac, something else on Linux CI. Each test
// below pins the platform it means to exercise instead of inheriting the
// host's, so both branches are deterministic on any OS.
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

function stubPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(navigator, "platform", originalPlatform);
  }
});

describe("isAdditiveSelectClick", () => {
  test("cmd-click is additive", () => {
    expect(isAdditiveSelectClick({ metaKey: true, ctrlKey: false })).toBe(true);
  });

  test("ctrl-click is not additive on Mac (it's the context-menu gesture)", () => {
    stubPlatform("MacIntel");
    expect(isAdditiveSelectClick({ metaKey: false, ctrlKey: true })).toBe(
      false,
    );
  });

  test("ctrl-click is additive on non-Mac", () => {
    stubPlatform("Linux x86_64");
    expect(isAdditiveSelectClick({ metaKey: false, ctrlKey: true })).toBe(true);
  });

  test("a plain click is not additive", () => {
    expect(isAdditiveSelectClick({ metaKey: false, ctrlKey: false })).toBe(
      false,
    );
  });
});

describe("isRowActivationKey", () => {
  test("Enter and Space activate", () => {
    expect(isRowActivationKey("Enter")).toBe(true);
    expect(isRowActivationKey(" ")).toBe(true);
  });

  test("other keys do not activate", () => {
    expect(isRowActivationKey("Tab")).toBe(false);
    expect(isRowActivationKey("a")).toBe(false);
  });
});

describe("rowActivationProps", () => {
  test("carries a button role and a tab stop", () => {
    const props = rowActivationProps(() => {});
    expect(props.role).toBe("button");
    expect(props.tabIndex).toBe(0);
  });

  test("Enter/Space fire onSelect and prevent default; other keys do not", () => {
    let calls = 0;
    const props = rowActivationProps(() => {
      calls += 1;
    });
    let prevented = false;
    const event = (key: string) =>
      ({
        key,
        preventDefault: () => {
          prevented = true;
        },
      }) as unknown as Parameters<typeof props.onKeyDown>[0];

    props.onKeyDown(event("Enter"));
    expect(calls).toBe(1);
    expect(prevented).toBe(true);

    prevented = false;
    props.onKeyDown(event("a"));
    expect(calls).toBe(1);
    expect(prevented).toBe(false);
  });

  test("clicking fires onSelect", () => {
    let calls = 0;
    const props = rowActivationProps(() => {
      calls += 1;
    });
    props.onClick();
    expect(calls).toBe(1);
  });
});
