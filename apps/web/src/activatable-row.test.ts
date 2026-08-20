import { describe, expect, test } from "bun:test";

import { isRowActivationKey, rowActivationProps } from "./activatable-row";

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
