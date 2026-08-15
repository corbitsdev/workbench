import { expect, test } from "bun:test";
import { auditUiVocabulary, stripNonUserFacing } from "../ui-vocabulary";

test("clean prose passes with no violations", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/pages/home-page.tsx",
      contents: `title="Pick a workbench from the switcher, then Myra will open here."`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a banned term inside natural-language JSX copy is a violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/pages/agents-settings-section.tsx",
      contents: `description="Choose a bench from the rail to see its agents."`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain(
    "apps/web/src/pages/agents-settings-section.tsx",
  );
  expect(report.violations[0]).toContain("bench");
});

test("reports every banned term present, not just the first", () => {
  const report = auditUiVocabulary([
    {
      relPath: "a.tsx",
      contents: [
        `title="No bench selected"`,
        `description="Choose a workbench from the rail to continue"`,
      ].join("\n"),
    },
  ]);
  expect(report.violations.length).toBeGreaterThanOrEqual(2);
});

test("'workbench' itself never false-matches 'bench'", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/pages/home-page.tsx",
      contents: `title="No workbench selected"`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("single-word type/scope literals are not prose and don't trip the check", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/routines-api.ts",
      contents: `scope: "'personal' | 'bench'",`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("space-separated CSS class lists are not prose", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/shell/rail.tsx",
      contents: `className="shell-brand-rail-column shell-brand-rail-column--labels"`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("API paths are not prose", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/pages/library-page.tsx",
      contents: "`/api/tenants/${selectedTenantId}/artifacts`",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("code comments are never scanned", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/app.tsx",
      contents: "// screens that talk to the hub only mount once ready",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("console/logger calls are never scanned", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/app.tsx",
      contents: `console.log("The hub is unreachable right now");`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("an apostrophe in JSX prose never swallows the rest of the file into one giant match", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/pages/routines-page.tsx",
      contents: [
        `<p>On webhook — manage the hook URL and secret from this routine's detail page.</p>`,
        `title="No bench selected"`,
      ].join("\n"),
    },
  ]);
  // Only the real "No bench selected" literal on line 2 should be flagged —
  // not a false match spanning from the apostrophe in "routine's" onward.
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain(":2:");
});

test("multi-line template literals are still scanned", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/pages/onboarding-page.tsx",
      contents: [
        "const message = `Your key checked out, and every",
        "  default routine on your bench has already fired`;",
      ].join("\n"),
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a reintroduced Channels nav band label is a violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/routes.tsx",
      contents: `label: "Channels",`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/web/src/routes.tsx");
  expect(report.violations[0]).toContain("Channels");
});

test("a reintroduced Channels page band title is a violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/shell/panel-contributions.tsx",
      contents: `title: "Channels",`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a reintroduced Channels aria-label is a violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/shell/panel-contributions.tsx",
      contents: `<div className="panel-stack" aria-label="Channels">`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a reintroduced Channels JSX title attribute is a violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/shell/rail.tsx",
      contents: `<SidebarPanelHeader title="Channels" />`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a reintroduced Channels JSX label attribute is a violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/shell/rail.tsx",
      contents: `<NavItem label="Channels" />`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
});

test("prose that merely mentions Channels is not a band-label violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/shell/panel-contributions.tsx",
      contents: `description="Channels and running routines for this workbench will appear here."`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a command palette heading grouping channel search results is not a band-label violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "apps/web/src/command-palette-provider.tsx",
      contents: `heading: "Channels",`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("chat-ui's channel-kind section label is not a band-label violation", () => {
  const report = auditUiVocabulary([
    {
      relPath: "packages/chat-ui/src/strings.ts",
      contents: `channelsSectionLabel: "Channels",`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("stripNonUserFacing preserves line and column positions", () => {
  const source = [
    "// a comment about the hub",
    'const x = "workbench";',
    "console.log(`the hub answered`);",
  ].join("\n");
  const stripped = stripNonUserFacing(source);
  expect(stripped.split("\n")).toHaveLength(3);
  expect(stripped).not.toContain("hub");
  expect(stripped).toContain("workbench");
});
