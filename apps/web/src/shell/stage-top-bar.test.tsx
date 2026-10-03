import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StageTopBar } from "./stage-top-bar";

describe("StageTopBar", () => {
  test("titles the stage with plain text — no breadcrumb trail", () => {
    const html = renderToStaticMarkup(<StageTopBar title="Run history" subtitle="12 runs" />);
    expect(html).toContain("Run history");
    expect(html).not.toContain("stage-crumbs");
    expect(html).not.toContain("stage-crumb");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("<a ");
  });

  test("keeps the page's own subtitle and actions", () => {
    const html = renderToStaticMarkup(
      <StageTopBar title="Tools" actions={<button type="button">Add server</button>} />,
    );
    expect(html).toContain("Add server");
    expect(html).toContain("Tools");
  });
});
