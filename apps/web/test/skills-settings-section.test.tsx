// Settings · Skills (CL-5990): session drafts. Mirrors the former
// `skills-page.test.tsx` coverage, mounted as a settings section instead of
// a stage-only page paired with a col2 list.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { validationIssues } from "../src/pages/create-skill-dialog";
import { SkillsSettingsSection } from "../src/pages/skills-settings-section";
import type { Skill } from "../src/skills-session";
import { resetSessionSkills } from "../src/skills-session";
import { TestQueryProvider } from "./test-query-provider";

const draftSkill: Skill = {
  id: "skill_1",
  name: "Brief writer",
  description: "Turns notes into a research brief",
  body: "Always cite sources.",
  access: "Private",
  owner: "You",
  updatedAt: "2026-08-05T11:00:00.000Z",
  version: "0.1.0",
  pinnedBy: [],
  versions: [
    {
      version: "0.1.0",
      note: "Session draft",
      who: "You",
      whenIso: "2026-08-05T11:00:00.000Z",
      current: true,
    },
  ],
  sessionLocal: true,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  resetSessionSkills();
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(
  props: {
    readonly skills?: readonly Skill[];
    readonly entityId?: string | null;
    readonly navigate?: (to: string) => void;
  } = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <SkillsSettingsSection {...props} />
      </TestQueryProvider>,
    );
  });
  return container;
}

describe("SkillsSettingsSection", () => {
  test("renders the honest empty state with no drafts", async () => {
    const el = await mount();
    expect(el.textContent).toContain("No skills yet");
    expect(el.textContent).toContain("reusable capability");
  });

  test("lists drafts when nothing is selected", async () => {
    const el = await mount({ skills: [draftSkill] });
    expect(el.textContent).toContain("Brief writer");
    expect(el.textContent).toContain("New skill");
  });

  test("entityId selects the draft's detail", async () => {
    const el = await mount({ skills: [draftSkill], entityId: "skill_1" });
    expect(el.textContent).toContain("Session draft");
    expect(el.innerHTML).toContain('title="Restore needs a skill registry"');
  });

  test("navigate is called with the section sub-path when a row is selected", async () => {
    const navigated: string[] = [];
    const el = await mount({
      skills: [draftSkill],
      navigate: (to) => navigated.push(to),
    });
    const row = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Brief writer"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toContain("/settings/skills/skill_1");
  });
});

describe("CreateSkillDialog validation", () => {
  test("an empty draft is missing a name and a body, never a description", () => {
    expect(validationIssues({ name: "", description: "", body: "" })).toEqual([
      "Name is required.",
      "Skill body is required.",
    ]);
  });

  test("a complete draft has no validation issues", () => {
    expect(
      validationIssues({
        name: "Summarize",
        description: "x",
        body: "do the thing",
      }),
    ).toEqual([]);
  });
});
