import { expect, test } from "bun:test";

import { argumentsSummaryFor, headlineFor } from "./headline";

test("falls back to a generic label when the tool definition carries neither", () => {
  expect(headlineFor({}, {})).toBe("Run a tool");
  expect(headlineFor(null, null)).toBe("Run a tool");
});

test("prefers the bare tool name when no description is present", () => {
  expect(headlineFor({ name: "send_email" }, {})).toBe("send_email");
});

test("prefers the human-readable description over the bare name", () => {
  expect(
    headlineFor(
      {
        name: "send_email",
        description: "Sends an email on the tenant's behalf",
      },
      {},
    ),
  ).toBe("Sends an email on the tenant's behalf");
});

test("folds in the live call's title argument, when present, as the specific ask", () => {
  expect(
    headlineFor(
      {
        name: "pain_point_collateral_finalize",
        description:
          "Finalizes one piece of pain-point sales collateral, pending human approval, and prepares it as a Library artifact.",
      },
      {
        title: "Faster onboarding for Acme Corp",
        painPoint: "Slow onboarding",
      },
    ),
  ).toBe(
    'Finalizes one piece of pain-point sales collateral, pending human approval, and prepares it as a Library artifact.: "Faster onboarding for Acme Corp"',
  );
});

test("ignores a blank or non-string title rather than rendering an empty quote", () => {
  expect(headlineFor({ name: "send_email" }, { title: "   " })).toBe("send_email");
  expect(headlineFor({ name: "send_email" }, { title: 42 })).toBe("send_email");
});

test("workflow_deploy renders the package name, short sha, and declared tool pins directly, ignoring the tool's own description", () => {
  expect(
    headlineFor(
      { name: "workflow_deploy", description: "Deploy a workflow asset..." },
      {
        assetId: "asset_daily_digest",
        commitSha: "abcdef1234567890",
        entry: "./workflow.ts",
        packageName: "daily-digest",
        toolPackagePins: [
          { name: "@corbits/email-tools", version: "1.2.3" },
          { name: "@corbits/http-tools", version: "0.4.0" },
        ],
      },
    ),
  ).toBe(
    "Deploy workflow daily-digest @ abcdef1 — tools: @corbits/email-tools@1.2.3, @corbits/http-tools@0.4.0",
  );
});

test("workflow_deploy with no declared pins reads as 'none declared' rather than an empty list", () => {
  expect(
    headlineFor(
      { name: "workflow_deploy" },
      {
        assetId: "asset_daily_digest",
        commitSha: "abcdef1234567890",
        packageName: "daily-digest",
        toolPackagePins: [],
      },
    ),
  ).toBe("Deploy workflow daily-digest @ abcdef1 — tools: none declared");
});

test("workflow_deploy falls back to the bare assetId when packageName is missing", () => {
  expect(
    headlineFor(
      { name: "workflow_deploy" },
      { assetId: "asset_daily_digest", commitSha: "abcdef1234567890" },
    ),
  ).toBe("Deploy workflow asset_daily_digest @ abcdef1 — tools: none declared");
});

test("argumentsSummaryFor: write_file reads as its path plus a content preview", () => {
  expect(
    argumentsSummaryFor(
      { name: "write_file" },
      { path: "/reports/summary.md", content: "# Q3 recap\n\nRevenue grew..." },
    ),
  ).toBe('/reports/summary.md: "# Q3 recap\n\nRevenue grew..."');
});

test("argumentsSummaryFor: write_file truncates a long content preview to ~120 characters", () => {
  const content = "x".repeat(200);
  const summary = argumentsSummaryFor({ name: "write_file" }, { path: "/a.txt", content });
  expect(summary).toBe(`/a.txt: "${"x".repeat(120)}…"`);
});

test("argumentsSummaryFor: write_file with no content shows just the path", () => {
  expect(argumentsSummaryFor({ name: "write_file" }, { path: "/a.txt" })).toBe("/a.txt");
});

test("argumentsSummaryFor: other tools render a compact key: value list", () => {
  expect(
    argumentsSummaryFor({ name: "send_email" }, { to: "alice@example.com", subject: "Hi" }),
  ).toBe("to: alice@example.com, subject: Hi");
});

test("argumentsSummaryFor: truncates a long generic argument list", () => {
  const summary = argumentsSummaryFor({ name: "send_email" }, { body: "y".repeat(200) });
  expect(summary?.length).toBe(121); // 120 chars + the ellipsis
  expect(summary?.endsWith("…")).toBe(true);
});

test("argumentsSummaryFor: undefined when there are no arguments to show", () => {
  expect(argumentsSummaryFor({ name: "send_email" }, {})).toBeUndefined();
  expect(argumentsSummaryFor({ name: "send_email" }, null)).toBeUndefined();
});
