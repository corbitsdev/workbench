// Agents and Skills moved from Settings sections back to their own rail
// routes (CL-6354/CL-6355); Library was renamed Files off its own prefix
// (CL-6353). Old links must still land somewhere real: these components
// bounce to the new home, preserving any deep-linked id.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  LegacyLibraryRedirect,
  LegacySettingsAgentsRedirect,
  LegacySettingsSkillsRedirect,
} from "../src/pages/legacy-settings-redirects";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
}

describe("LegacySettingsAgentsRedirect", () => {
  test("bare /settings/agents redirects to /agents", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacySettingsAgentsRedirect
        path="/settings/agents"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/agents"]);
  });

  test("/settings/agents/:id preserves the id at its new home", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacySettingsAgentsRedirect
        path="/settings/agents/wfd_1"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/agents/wfd_1"]);
  });
});

describe("LegacySettingsSkillsRedirect", () => {
  test("bare /settings/skills redirects to /skills", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacySettingsSkillsRedirect
        path="/settings/skills"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/skills"]);
  });

  test("/settings/skills/:id preserves the id at its new home", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacySettingsSkillsRedirect
        path="/settings/skills/skill_1"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/skills/skill_1"]);
  });
});

describe("LegacyLibraryRedirect", () => {
  test("bare /library redirects to /files", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacyLibraryRedirect
        path="/library"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/files"]);
  });

  test("/library/:id preserves the id at its new home", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacyLibraryRedirect
        path="/library/art_1"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/files/art_1"]);
  });
});
