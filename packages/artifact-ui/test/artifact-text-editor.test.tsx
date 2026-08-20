// Static-render smoke tests: `ArtifactTextEditor` renders the doc's live
// text and the honest save-state line for the three states a viewer can
// land on — read-only, mid-edit, and confirmed-saved. Interactive
// behavior (typing diffing into the Y.Text, remote updates re-rendering
// the textarea) is covered by `y-text-diff.test.ts`'s pure diff/apply
// tests plus this component's own thin `onChange` wiring, which
// `renderToStaticMarkup` can't exercise (no event loop) — this file only
// proves the initial render is honest for each state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Y from "yjs";

import { ArtifactTextEditor } from "../src/artifact-text-editor";

function docWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

describe("ArtifactTextEditor", () => {
  test("renders the doc's current text and marks a read-only viewer's textarea readonly", () => {
    const markup = renderToStaticMarkup(
      <ArtifactTextEditor
        doc={docWithText("shared content")}
        title="Notes"
        readOnly
        saveState={{ kind: "read-only" }}
      />,
    );

    expect(markup).toContain("shared content");
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('aria-readonly="true"');
  });

  test("an editable viewer's textarea is not marked readonly", () => {
    const markup = renderToStaticMarkup(
      <ArtifactTextEditor
        doc={docWithText("draft")}
        title="Notes"
        readOnly={false}
        saveState={{ kind: "unsaved" }}
      />,
    );

    expect(markup).not.toContain('readOnly=""');
    expect(markup).toContain('aria-readonly="false"');
    expect(markup).toContain("Unsaved changes");
  });

  test("renders an editing indicator naming the co-editor", () => {
    const markup = renderToStaticMarkup(
      <ArtifactTextEditor
        doc={docWithText("x")}
        title="Notes"
        readOnly={false}
        saveState={{ kind: "editing", by: ["Priya"] }}
      />,
    );

    expect(markup).toContain("Priya is editing");
  });

  test("renders a confirmed save with its real version number, never a placeholder", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      <ArtifactTextEditor
        doc={docWithText("x")}
        title="Notes"
        readOnly={false}
        saveState={{ kind: "saved", version: 12, savedAt: now }}
      />,
    );

    expect(markup).toContain("v12");
  });
});
