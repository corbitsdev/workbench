// Screen-level proof for the Skills page shell (UI only). The page is
// honest about having no registry yet: it renders an empty state and a
// Create action, and the create dialog collects a draft but never POSTs.
// Mirrors the SSR shape used by pages.test.tsx / agents-page.test.tsx.
// Auto-select navigates via useEffect, so that case mounts under happy-dom.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { validationIssues } from "../src/pages/create-skill-dialog";
import { SkillsPage } from "../src/pages/skills-page";
import type { Skill } from "../src/skills-session";
import { resetSessionSkills } from "../src/skills-session";

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

describe("SkillsPage shell", () => {
  test("renders the honest empty state", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).toContain("No skills yet");
    expect(markup).toContain("reusable capability");
  });

  test("hides the toolbar (search + view toggle) when there are no skills", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).not.toContain("Search skills");
  });

  test("exposes a primary Create skill action from the empty state", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).toContain("Create skill");
  });

  test("session drafts keep Restore disabled (no registry)", () => {
    const markup = renderToStaticMarkup(
      <SkillsPage skills={[draftSkill]} path="/skills/skill_1" />,
    );
    expect(markup).toContain("Session draft");
    // title + disabled on the Restore control — honest until a registry exists
    expect(markup).toContain('title="Restore needs a skill registry"');
    expect(markup).toContain("disabled");
  });
});

describe("SkillsPage auto-select", () => {
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

  test("navigates to the first skill when the path has no id", async () => {
    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SkillsPage
          skills={[draftSkill]}
          path="/skills"
          navigate={(to) => {
            navigated.push(to);
          }}
        />,
      );
    });

    expect(navigated).toEqual(["/skills/skill_1"]);
  });

  test("does not navigate when a skill id is already in the path", async () => {
    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SkillsPage
          skills={[draftSkill]}
          path="/skills/skill_1"
          navigate={(to) => {
            navigated.push(to);
          }}
        />,
      );
    });

    expect(navigated).toEqual([]);
  });

  test("does not navigate when the skills list is empty", async () => {
    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SkillsPage
          skills={[]}
          path="/skills"
          navigate={(to) => {
            navigated.push(to);
          }}
        />,
      );
    });

    expect(navigated).toEqual([]);
  });
});

describe("CreateSkillDialog", () => {
  // The dialog renders through @corbits/react-ui's Radix Dialog.Portal, which
  // needs a real DOM and yields no markup under renderToStaticMarkup (same
  // reason chat-ui's NewChannelDialog has no render test). Its validation
  // logic is exported and tested directly instead.
  test("an empty draft is missing a name and a body, never a description", () => {
    expect(validationIssues({ name: "", description: "", body: "" })).toEqual([
      "Name is required.",
      "Skill body is required.",
    ]);
  });

  test("a name without a body still cannot be submitted", () => {
    expect(
      validationIssues({ name: "Summarize", description: "", body: "" }),
    ).toEqual(["Skill body is required."]);
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
