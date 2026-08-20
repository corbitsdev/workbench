import { describe, expect, test } from "bun:test";

import { resolveTarget } from "../src/target-resolver";
import type { TargetDefinition } from "../src/target-resolver";

type Target =
  | { readonly type: "channel"; readonly id: string }
  | { readonly type: "routine"; readonly id: string };

const definitions: readonly TargetDefinition<Target>[] = [
  {
    selector: "[data-ctx-channel]",
    resolve: (element) => {
      const id = element.getAttribute("data-ctx-channel");
      return id === null ? null : { type: "channel", id };
    },
  },
  {
    selector: "[data-ctx-routine]",
    resolve: (element) => {
      const id = element.getAttribute("data-ctx-routine");
      return id === null ? null : { type: "routine", id };
    },
  },
];

function mountHTML(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

describe("resolveTarget", () => {
  test("resolves the nearest matching ancestor", () => {
    const container = mountHTML(
      '<div data-ctx-channel="ch-1"><span id="label">Launch</span></div>',
    );
    const label = container.querySelector("#label");
    expect(resolveTarget(label, definitions, null)).toEqual({
      type: "channel",
      id: "ch-1",
    });
  });

  test("tries definitions in order and returns the first match", () => {
    const container = mountHTML(
      '<div data-ctx-routine="rt-1"><div data-ctx-channel="ch-1"><span id="inner"></span></div></div>',
    );
    const inner = container.querySelector("#inner");
    expect(resolveTarget(inner, definitions, null)).toEqual({
      type: "channel",
      id: "ch-1",
    });
  });

  test("falls through to the fallback when nothing matches", () => {
    const container = mountHTML('<div><span id="plain"></span></div>');
    const plain = container.querySelector("#plain");
    expect(resolveTarget(plain, definitions, "shell")).toBe("shell");
  });

  test("falls through when resolve opts out with null", () => {
    const container = mountHTML(
      '<div data-ctx-channel=""><span id="empty"></span></div>',
    );
    const empty = container.querySelector("#empty");
    // The attribute is present but empty; resolve() sees a real string ("")
    // and this fixture's resolver still builds a target from it — swap in a
    // resolver that opts out to exercise the fallthrough.
    const optOutDefinitions: readonly TargetDefinition<Target>[] = [
      {
        selector: "[data-ctx-channel]",
        resolve: () => null,
      },
    ];
    expect(resolveTarget(empty, optOutDefinitions, "shell")).toBe("shell");
  });

  test("returns the fallback for a non-Element origin", () => {
    expect(resolveTarget(null, definitions, "shell")).toBe("shell");
  });
});
