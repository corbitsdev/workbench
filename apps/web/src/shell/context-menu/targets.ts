// What a right-click (or a document-level Ctrl-click) can land on across the
// shell. New target types register a selector here and an item builder in
// `items.tsx` — that's the whole surface for adding one.

import type { TargetDefinition } from "@corbits/context-menu";

export type ShellContextMenuTarget =
  | { readonly type: "shell" }
  | { readonly type: "account" }
  | {
      readonly type: "workbench";
      readonly id: string;
      readonly title: string;
      readonly pinned: boolean;
    }
  | {
      readonly type: "profile";
      readonly address: string;
      readonly handle: string;
    }
  | { readonly type: "routine"; readonly id: string; readonly name: string }
  | { readonly type: "insights-run"; readonly id: string };

function attr(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null || value === "" ? null : value;
}

// Order matters: `resolveTarget` returns the first definition whose selector
// matches anywhere in the ancestor chain, not the nearest match overall — so
// a target nested inside another (the profile face inside a workbench row)
// must be listed before its container.
export const SHELL_CONTEXT_MENU_TARGETS: readonly TargetDefinition<ShellContextMenuTarget>[] =
  [
    {
      selector: "[data-ctx-account]",
      resolve: () => ({ type: "account" }),
    },
    {
      selector: "[data-ctx-profile-address]",
      resolve: (element) => {
        const address = attr(element, "data-ctx-profile-address");
        const handle = attr(element, "data-ctx-profile-handle");
        if (address === null || handle === null) return null;
        return { type: "profile", address, handle };
      },
    },
    {
      selector: "[data-ctx-workbench]",
      resolve: (element) => {
        const id = attr(element, "data-ctx-workbench");
        if (id === null) return null;
        return {
          type: "workbench",
          id,
          title: attr(element, "data-ctx-workbench-title") ?? id,
          pinned: attr(element, "data-ctx-workbench-pinned") === "true",
        };
      },
    },
    {
      selector: "[data-ctx-routine]",
      resolve: (element) => {
        const id = attr(element, "data-ctx-routine");
        if (id === null) return null;
        return {
          type: "routine",
          id,
          name: attr(element, "data-ctx-routine-name") ?? id,
        };
      },
    },
    {
      selector: "[data-ctx-insights-run]",
      resolve: (element) => {
        const id = attr(element, "data-ctx-insights-run");
        if (id === null) return null;
        return { type: "insights-run", id };
      },
    },
  ];

export const SHELL_CONTEXT_MENU_FALLBACK: ShellContextMenuTarget = {
  type: "shell",
};
