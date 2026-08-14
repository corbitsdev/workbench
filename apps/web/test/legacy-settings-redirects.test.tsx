// Agents and Skills moved from their own rail routes into Settings
// sections (CL-5990). Old `/agents[/:id]` and `/skills[/:id]` links must
// still land somewhere real: these two components bounce to the section's
// new home, preserving any deep-linked id.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  LegacyAgentsRedirect,
  LegacySkillsRedirect,
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

describe("LegacyAgentsRedirect", () => {
  test("bare /agents redirects to /settings/agents", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacyAgentsRedirect
        path="/agents"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/settings/agents"]);
  });

  test("/agents/:id preserves the id at its new home", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacyAgentsRedirect
        path="/agents/wfd_1"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/settings/agents/wfd_1"]);
  });
});

describe("LegacySkillsRedirect", () => {
  test("bare /skills redirects to /settings/skills", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacySkillsRedirect
        path="/skills"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/settings/skills"]);
  });

  test("/skills/:id preserves the id at its new home", async () => {
    const navigated: string[] = [];
    await mount(
      <LegacySkillsRedirect
        path="/skills/skill_1"
        navigate={(to) => navigated.push(to)}
      />,
    );
    expect(navigated).toEqual(["/settings/skills/skill_1"]);
  });
});
