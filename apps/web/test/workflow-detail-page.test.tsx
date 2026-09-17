// `/workflows/<definitionId>` (CL-7371, thinned CL-8160): a workflow
// definition's own page. Covers the pure `WorkflowDetailPage` body
// against fixtures for what stock's `GET /workflows/definitions` (via
// `getWorkflowDefinitionDetail`) actually exposes — name, description,
// status, and current version — now that the hub-composed detail read
// (lifecycle, source commit, steps, grants, credential bindings) is gone.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkflowDetailPage } from "../src/pages/workflow-detail-page";
import type { WorkflowDefinitionDetailT } from "../src/workflow-detail-api";

const baseDetail: WorkflowDefinitionDetailT = {
  definitionId: "wfd_1",
  name: "Outreach",
  description: "Sends outreach messages",
  status: "deployed",
  currentVersion: "3",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("WorkflowDetailPage", () => {
  test("a deployed workflow shows no not-launchable strip", () => {
    const html = renderToStaticMarkup(<WorkflowDetailPage detail={baseDetail} />);
    expect(html).toContain("Deployed");
    expect(html).toContain("v3");
    expect(html).toContain("Sends outreach messages");
    expect(html).not.toContain("resume it to make it launchable");
  });

  test("a stopped workflow shows the why-not-launchable strip", () => {
    const detail: WorkflowDefinitionDetailT = {
      ...baseDetail,
      status: "stopped",
    };
    const html = renderToStaticMarkup(<WorkflowDetailPage detail={detail} />);
    expect(html).toContain("Stopped");
    expect(html).toContain("resume it to make it launchable");
  });

  test("a definition with no description renders without one", () => {
    const detail: WorkflowDefinitionDetailT = {
      definitionId: "wfd_2",
      name: "New workflow",
      status: "deployed",
      currentVersion: "1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const html = renderToStaticMarkup(<WorkflowDetailPage detail={detail} />);
    expect(html).toContain("New workflow");
    expect(html).toContain("Deployed");
  });
});
