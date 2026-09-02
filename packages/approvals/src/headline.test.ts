import { expect, test } from "bun:test";

import { headlineFor } from "./headline";

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
  expect(headlineFor({ name: "send_email" }, { title: "   " })).toBe(
    "send_email",
  );
  expect(headlineFor({ name: "send_email" }, { title: 42 })).toBe("send_email");
});

test("workflow_deploy renders the asset, short sha, and grant surface directly, ignoring the tool's own description", () => {
  expect(
    headlineFor(
      { name: "workflow_deploy", description: "Deploy a workflow asset..." },
      {
        assetId: "asset_daily_digest",
        commitSha: "abcdef1234567890",
        entry: "./workflow.ts",
        expectedWireHash: "wire_abc",
        grants: ["email:*/send", "http:api.example.com/*"],
      },
    ),
  ).toBe(
    "Deploy workflow asset_daily_digest @ abcdef1 — grants: email:*/send, http:api.example.com/*",
  );
});

test("workflow_deploy with no grants reads as 'no grants' rather than an empty list", () => {
  expect(
    headlineFor(
      { name: "workflow_deploy" },
      {
        assetId: "asset_daily_digest",
        commitSha: "abcdef1234567890",
        grants: [],
      },
    ),
  ).toBe("Deploy workflow asset_daily_digest @ abcdef1 — grants: no grants");
});
