// Screen-level proof for the Skills page shell (UI only). The page is
// honest about having no registry yet: it renders an empty state and a
// Create action, and the create dialog collects a draft but never POSTs.
// Mirrors the SSR shape used by pages.test.tsx / agents-page.test.tsx.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { validationIssues } from "../src/pages/create-skill-dialog";
import { SkillsPage } from "../src/pages/skills-page";

describe("SkillsPage shell", () => {
  test("renders the toolbar and the honest empty state", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).toContain("Search skills");
    expect(markup).toContain("No skills yet");
    expect(markup).toContain("reusable capability");
  });

  test("exposes a primary Create skill action from the empty state", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).toContain("Create skill");
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
