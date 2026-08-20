// Screens without live backing must say so: every list renders an honest
// empty state from real (empty) hub responses, never placeholder rows.
// Skills coverage moved to `skills-settings-section.test.tsx` (CL-5990 —
// it became a Settings section, not a stage-only page with an injectable
// directory prop). Agents' Settings section was cut in CL-6121 — agent
// configuration lives per-workbench now, not as a global tab.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArtifactSummary } from "@corbits/artifact-ui";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { LibraryPage } from "../src/pages/library-page";
import { SettingsRoute } from "../src/pages/settings-page";
import { TestQueryProvider } from "./test-query-provider";

describe("empty states", () => {
  test("library teaches what will appear once the seam is real", () => {
    const markup = renderToStaticMarkup(<LibraryPage artifacts={[]} />);
    expect(markup).toContain("No files yet");
    expect(markup).toContain(
      "Upload a file, or let your agents drop their work here",
    );
  });
});

describe("live data", () => {
  const reportArtifact: ArtifactSummary = {
    id: "art_1",
    title: "Q3 report",
    kind: "deck",
    ownerName: "Ada",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const csvArtifact: ArtifactSummary = {
    id: "art_2",
    title: "Signups export",
    kind: "csv",
    ownerName: null,
    createdAt: "2026-08-02T00:00:00.000Z",
  };

  test("library renders every artifact it's given", () => {
    const markup = renderToStaticMarkup(
      <LibraryPage artifacts={[reportArtifact, csvArtifact]} />,
    );
    expect(markup).toContain("Q3 report");
    expect(markup).toContain("Signups export");
  });

  test("library with onUpload puts Upload in the top bar, not the toolbar", () => {
    const markup = renderToStaticMarkup(
      <LibraryPage artifacts={[reportArtifact]} onUpload={() => undefined} />,
    );
    // Hidden file input behind the top-bar Upload action and
    // workbench:library:upload.
    expect(markup).toContain('type="file"');
    expect(markup).toContain('aria-label="Upload files"');
    expect(markup).toContain("sr-only");
    // Upload is a top-bar action (mock: primary chip in `.top`).
    expect(markup).toMatch(/stage-top-bar-actions[\s\S]*?>Upload</);
    // Sort is icon-only with an accessible name.
    expect(markup).toContain('aria-label="Newest first"');
  });
});

describe("settings top bar", () => {
  test("titles the bar with the active section", () => {
    const markup = renderToStaticMarkup(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <SettingsRoute
              path="/settings/account"
              navigate={() => undefined}
            />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(markup).toContain('href="/settings"');
    expect(markup).toContain('aria-current="page">General</span>');
  });
});
