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

  // CL-6750 — empty Files must tell one story: invite to add files. A
  // "0 files" count beside the poster reads as a second empty announcement,
  // and a labeled ghost file input twins the visible Upload button.
  test("empty library is one invitation, not count + poster + twin uploads", () => {
    const markup = renderToStaticMarkup(
      <LibraryPage artifacts={[]} onUpload={() => undefined} />,
    );
    expect(markup).toContain("No files yet");
    expect(markup).not.toContain("0 files");
    // One visible Upload in the top bar.
    expect(markup).toMatch(/stage-top-bar-actions[\s\S]*?>Upload</);
    // Hidden picker exists for the button, but is not a second labeled control.
    expect(markup).toContain('type="file"');
    expect(markup).toContain("sr-only");
    expect(markup).not.toContain('aria-label="Upload files"');
    expect(markup).toMatch(/type="file"[^>]*aria-hidden/);
    expect(markup).toMatch(/type="file"[^>]*tabindex="-1"/);
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
    // workbench:library:upload — unlabeled so it is not a twin control.
    expect(markup).toContain('type="file"');
    expect(markup).toContain("sr-only");
    expect(markup).not.toContain('aria-label="Upload files"');
    expect(markup).toMatch(/type="file"[^>]*aria-hidden/);
    expect(markup).toMatch(/type="file"[^>]*tabindex="-1"/);
    // Upload is a top-bar action (mock: primary chip in `.top`).
    expect(markup).toMatch(/stage-top-bar-actions[\s\S]*?>Upload</);
    // Sort is icon-only with an accessible name.
    expect(markup).toContain('aria-label="Newest first"');
    // With files present, the count subtitle is the honest inventory.
    expect(markup).toContain("1 files");
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
