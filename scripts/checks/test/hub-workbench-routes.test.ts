import { expect, test } from "bun:test";
import { auditHubWorkbenchRoutes } from "../hub-workbench-routes";

const CLEAN_INDEX = `import { createApp } from "@corbits/hub";
const scheduledDeliveryJoinDeps = {};
async function resolve() {
  const rows = await chatStore.listWorkbenchSettings(tenantId);
  return rows;
}
app.route(\`\${TENANT_PREFIX}/chat\`, createChatRoutes({}));
`;

test("a hub index with no github mount and only the delivery-seam reader passes", () => {
  const report = auditHubWorkbenchRoutes([
    { relPath: "apps/hub/src/index.ts", contents: CLEAN_INDEX },
  ]);
  expect(report.violations).toEqual([]);
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

test("listWorkbenchSettings outside the delivery seam is a violation", () => {
  const report = auditHubWorkbenchRoutes([
    {
      relPath: "apps/hub/src/other.ts",
      contents: `await chatStore.listWorkbenchSettings(tenantId);\n`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("listWorkbenchSettings");
});
