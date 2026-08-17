import { describe, expect, test } from "bun:test";
import { resolveTarget } from "@corbits/context-menu";

import {
  SHELL_CONTEXT_MENU_FALLBACK,
  SHELL_CONTEXT_MENU_TARGETS,
} from "./targets";

/** Parses `html`'s single root element and mounts it in the document, so
 * `origin.closest()` walks a real ancestor chain. */
function mount(html: string): Element {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const root = wrapper.firstElementChild;
  if (root === null) throw new Error("mount() requires a single root element");
  document.body.appendChild(root);
  return root;
}

function resolve(origin: Element | null) {
  return resolveTarget(
    origin,
    SHELL_CONTEXT_MENU_TARGETS,
    SHELL_CONTEXT_MENU_FALLBACK,
  );
}

describe("SHELL_CONTEXT_MENU_TARGETS", () => {
  test("resolves a channel row", () => {
    const container = mount(
      '<div data-ctx-channel="ch-1" data-ctx-channel-title="Launch" data-ctx-channel-pinned="true"><span id="inner"></span></div>',
    );
    expect(resolve(container.querySelector("#inner"))).toEqual({
      type: "channel",
      id: "ch-1",
      title: "Launch",
      pinned: true,
    });
  });

  test("channel row defaults title to the id and pinned to false when unset", () => {
    const container = mount('<div data-ctx-channel="ch-2"></div>');
    expect(resolve(container)).toEqual({
      type: "channel",
      id: "ch-2",
      title: "ch-2",
      pinned: false,
    });
  });

  test("resolves the profile face nested inside a channel row ahead of the channel itself", () => {
    const container = mount(
      '<div data-ctx-channel="ch-1"><span id="face" data-ctx-profile-address="agent:echo" data-ctx-profile-handle="echo"></span></div>',
    );
    expect(resolve(container.querySelector("#face"))).toEqual({
      type: "profile",
      address: "agent:echo",
      handle: "echo",
    });
  });

  test("resolves a routine row", () => {
    const container = mount(
      '<div data-ctx-routine="rt-1" data-ctx-routine-name="Nightly Digest"></div>',
    );
    expect(resolve(container)).toEqual({
      type: "routine",
      id: "rt-1",
      name: "Nightly Digest",
    });
  });

  test("resolves an insights run row", () => {
    const container = mount('<div data-ctx-insights-run="run-1"></div>');
    expect(resolve(container)).toEqual({
      type: "insights-run",
      id: "run-1",
    });
  });

  test("resolves the rail avatar as the account target", () => {
    const container = mount('<button data-ctx-account=""></button>');
    expect(resolve(container)).toEqual({ type: "account" });
  });

  test("falls back to the shell target for anything unmatched", () => {
    const container = mount('<div><span id="plain"></span></div>');
    expect(resolve(container.querySelector("#plain"))).toEqual(
      SHELL_CONTEXT_MENU_FALLBACK,
    );
  });
});
