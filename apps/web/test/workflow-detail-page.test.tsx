// `/workflows/<definitionAssetId>` (CL-7371): a workflow definition's own
// page. Covers the pure `WorkflowDetailPage` body against fixtures for the
// three things that matter first — the lifecycle badge/copy actually
// reflects `lifecycle`, steps render in order, and access reads declared
// vs. approved grants plus credential binding names, never a value.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkflowDetailPage } from "../src/pages/workflow-detail-page";
import type { WorkflowDefinitionDetailT } from "../src/workflow-detail-api";

const baseDetail: WorkflowDefinitionDetailT = {
  definitionAssetId: "asset_outreach",
  assetName: "outreach",
  displayName: "Outreach",
  description: "Sends outreach messages",
  lifecycle: "deployed",
  currentDefinitionId: "wfd_1",
  wireHash: "hash_1",
  source: {
    commitSha: "abcdef1234567890",
    entry: "src/index.ts",
    origin: "asset",
  },
  steps: [
    {
      id: "s1",
      role: "step",
      director: "outreach-agent",
      model: "claude-sonnet-5",
      toolPins: ["@corbits/mail-tools"],
      grants: ["mail:send"],
    },
  ],
  grants: {
    declared: ["mail:*:send"],
    approved: ["mail:*:send"],
  },
  credentialBindings: ["gmail"],
};

describe("WorkflowDetailPage", () => {
  test("a deployed workflow shows no not-launchable strip and renders its steps", () => {
    const html = renderToStaticMarkup(
      <WorkflowDetailPage detail={baseDetail} />,
    );
    expect(html).toContain("Deployed");
    expect(html).toContain("abcdef1");
    expect(html).toContain("outreach-agent");
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain("@corbits/mail-tools");
    expect(html).toContain("mail:send");
    expect(html).not.toContain(
      "This workflow's source has never been deployed",
    );
  });

  test("a pending-approval workflow shows the why-not-launchable strip", () => {
    const detail: WorkflowDefinitionDetailT = {
      ...baseDetail,
      lifecycle: "pending-approval",
      source: null,
    };
    const html = renderToStaticMarkup(<WorkflowDetailPage detail={detail} />);
    expect(html).toContain("Pending approval");
    expect(html).toContain("waiting on human approval");
  });

  test("access section reads declared vs. approved grants and credential names only", () => {
    const html = renderToStaticMarkup(
      <WorkflowDetailPage detail={baseDetail} />,
    );
    expect(html).toContain("Declared grants");
    expect(html).toContain("Approved grants");
    expect(html).toContain("gmail");
  });

  test("a source-only workflow with no steps says so plainly", () => {
    const detail: WorkflowDefinitionDetailT = {
      definitionAssetId: "asset_new",
      assetName: "new-workflow",
      displayName: "New workflow",
      lifecycle: "source-only",
      steps: [],
      grants: { declared: [], approved: [] },
      credentialBindings: [],
    };
    const html = renderToStaticMarkup(<WorkflowDetailPage detail={detail} />);
    expect(html).toContain("Source only");
    expect(html).toContain("No approved steps yet");
    expect(html).toContain("deploy it to make it launchable");
  });
});
