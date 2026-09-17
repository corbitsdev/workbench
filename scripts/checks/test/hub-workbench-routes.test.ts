import { expect, test } from "bun:test";
import { auditHubWorkbenchRoutes } from "../hub-workbench-routes";

const CLEAN_INDEX = `import { createApp } from "@corbits/hub";
function workbenchBelongsToTenant() {
  return true;
}
async function guard(tenantId: string, chatId: string) {
  const row = await chatStore.getWorkbenchSettings(tenantId, chatId);
  return row !== undefined && workbenchBelongsToTenant();
}
app.route(\`\${TENANT_PREFIX}/chat\`, createChatRoutes({}));
`;

test("a hub index with the guarded get-variant read and no github mount passes", () => {
  const report = auditHubWorkbenchRoutes([
    { relPath: "apps/hub/src/index.ts", contents: CLEAN_INDEX },
  ]);
  expect(report.violations).toEqual([]);
  expect(report.notes.length).toBeGreaterThan(0);
});

test("the createConnectGithubRoutes reference is a violation naming it", () => {
  const report = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/index.ts",
      contents: `${CLEAN_INDEX}\nimport { createConnectGithubRoutes } from "@corbits/connections/connect-github-routes";\n`,
    },
  ]);
  expect(report.violations.length).toBeGreaterThan(0);
  expect(report.violations[0]).toContain("createConnectGithubRoutes");
});

test("the bare /workbenches mount is a violation, a suffixed route is not", () => {
  const withMount = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/index.ts",
      contents: `${CLEAN_INDEX}\napp.route(\`\${TENANT_PREFIX}/workbenches\`, createConnectGithubRoutes({}));\n`,
    },
  ]);
  expect(withMount.violations.length).toBeGreaterThan(0);
  expect(withMount.violations.join("\n")).toContain("/workbenches");

  const withStream = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/index.ts",
      contents: `${CLEAN_INDEX}\napp.route(\`\${TENANT_PREFIX}/workbenches/:id/stream\`, createStreamRoute({}));\n`,
    },
  ]);
  expect(withStream.violations).toEqual([]);
});

test("a done-when rg line in hub src is a violation naming the file", () => {
  const report = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/other.ts",
      contents: `// the github workbench card reads state here\n`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/hub/src/other.ts");
});

test("a legacy templates import is a violation naming the package", () => {
  const report = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/other.ts",
      contents: `import { CONNECTOR_REGISTRY } from "@workbench/templates/connectors";\n`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@workbench/templates");
});

test("listWorkbenchSettings anywhere is a violation — T4 cut the only seam", () => {
  const report = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/index.ts",
      contents: `${CLEAN_INDEX}\nawait chatStore.listWorkbenchSettings(tenantId);\n`,
    },
  ]);
  expect(report.violations.length).toBeGreaterThan(0);
  expect(report.violations.join("\n")).toContain("listWorkbenchSettings");
});

test("a get/update read outside the command guard is a violation", () => {
  for (const call of [
    "await chatStore.getWorkbenchSettings(tenantId, chatId);",
    "await chatStore.updateWorkbenchSettings({ tenantId });",
  ]) {
    const report = auditHubWorkbenchRoutes([
      { relPath: "apps/hub/src/other.ts", contents: `${call}\n` },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("command guard");
  }
});
