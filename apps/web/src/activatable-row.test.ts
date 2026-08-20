import { describe, expect, test } from "bun:test";

import {
  isAdditiveSelectClick,
  isRowActivationKey,
  rowActivationProps,
} from "./activatable-row";

describe("isAdditiveSelectClick", () => {
  // The test DOM reports a Darwin platform, so these exercise the Mac rules.
  test("cmd-click is additive", () => {
    expect(isAdditiveSelectClick({ metaKey: true, ctrlKey: false })).toBe(true);
  });

  test("ctrl-click is not additive on Mac (it's the context-menu gesture)", () => {
    expect(isAdditiveSelectClick({ metaKey: false, ctrlKey: true })).toBe(
      false,
    );
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
