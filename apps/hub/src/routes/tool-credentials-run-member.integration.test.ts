/**
 * CL-3525: workflow run creator principal threads into tool-credentials
 * resolution; member OAuth is scoped per run (heartbeat brief / linear).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { findOAuthProviderConfig } from "@workbench/shared";
import { schema as intxSchema } from "@intx/db";
import { schema } from "../db";
import type { HubDb } from "../db";
import { insertOAuthCredential } from "../lib/oauth-flow";
import { encryptSecret } from "../lib/credential-crypto";
import { resolveMemberOrTenantToolCredential } from "../lib/member-tool-credential";
import { createToolCredentialsRouter } from "./tool-credentials";

const LINEAR = findOAuthProviderConfig("linear");
if (!LINEAR) throw new Error("linear OAuth catalog entry missing");

const TENANT = "ten-cl3525";
const MEMBER_A = "prn-member-a";
const MEMBER_B = "prn-member-b";
const DEPLOYMENT_ID = "ses_hb-dep";
const STEP_ID = "heartbeat-intake-linear";
const STEP_AGENT_ID = `ins_${DEPLOYMENT_ID}-${STEP_ID}`;
const SIDECAR_TOKEN = "sidecar-test-token";
const ENC_KEY = randomBytes(32).toString("base64");

const LINEAR_TOOL_PINS = [{ name: "@workbench/tools-linear", version: "^0.1.0" }];

const CLIENT_CONFIG = {
  clientId: "linear-client-id",
  clientSecret: "linear-client-secret",
  redirectUri: "https://hub.test/oauth/callback/linear",
};

let client: PGlite;
let db: HubDb;
let router: ReturnType<typeof createToolCredentialsRouter>;

async function postCredentials(body: {
  tenantId: string;
  agentId: string;
  providerNames: string[];
  workflowRunId?: string;
}): Promise<{ credentials: Record<string, { apiKey: string; baseURL: string }> }> {
  const res = await router.request("/tools/credentials", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SIDECAR_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`credentials POST failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    credentials: Record<string, { apiKey: string; baseURL: string }>;
  };
}

beforeAll(async () => {
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = ENC_KEY;
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
  router = createToolCredentialsRouter(db, SIDECAR_TOKEN);
});

afterAll(async () => {
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE credential, oauth_client, provider, workflow_run_record, agent
    RESTART IDENTITY CASCADE;
  `);

  await db.insert(intxSchema.agent).values({
    id: STEP_AGENT_ID,
    tenantId: TENANT,
    creatorPrincipalId: MEMBER_A,
    name: STEP_ID,
    toolPackages: LINEAR_TOOL_PINS,
  });

  await insertOAuthCredential({
    db,
    tenantId: TENANT,
    memberPrincipalId: MEMBER_A,
    providerConfig: LINEAR,
    clientConfig: CLIENT_CONFIG,
    token: { access_token: "linear-oauth-member-a", scope: "read write" },
  });
  await insertOAuthCredential({
    db,
    tenantId: TENANT,
    memberPrincipalId: MEMBER_B,
    providerConfig: LINEAR,
    clientConfig: CLIENT_CONFIG,
    token: { access_token: "linear-oauth-member-b", scope: "read write" },
  });

  const providerRows = await db.query.provider.findMany({
    where: (p, { eq }) => eq(p.tenantId, TENANT),
  });
  const linearProvider = providerRows.find((p) => p.name === "linear");
  if (!linearProvider) throw new Error("linear provider not seeded");

  await db.insert(intxSchema.credential).values({
    id: "cred-tenant-linear",
    tenantId: TENANT,
    principalId: null,
    providerId: linearProvider.id,
    name: "linear",
    type: "api_key",
    secret: encryptSecret("tenant-shared-linear-key"),
    status: "active",
  });
});

describe("POST /tools/credentials run-member isolation (CL-3525)", () => {
  test("resolveMemberOrTenantToolCredential returns member linear token", async () => {
    const direct = await resolveMemberOrTenantToolCredential(
      db,
      TENANT,
      MEMBER_A,
      "linear",
    );
    expect(direct?.apiKey).toBe("linear-oauth-member-a");
    expect(direct?.source).toBe("member");
  });

  test("heartbeat linear step uses run creator member OAuth, not tenant key", async () => {
    const runId = "run-member-a";
    await db.insert(schema.workflowRunRecord).values({
      id: runId,
      deploymentId: DEPLOYMENT_ID,
      kind: "heartbeat",
      tenantId: TENANT,
      principalId: MEMBER_A,
      status: "running",
    });

    const body = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: runId,
    });

    expect(body.credentials.linear?.apiKey).toBe("linear-oauth-member-a");
    expect(body.credentials.linear?.apiKey).not.toBe("tenant-shared-linear-key");
  });

  test("another member's run resolves that member's linear token only", async () => {
    const runA = "run-a";
    const runB = "run-b";
    await db.insert(schema.workflowRunRecord).values([
      {
        id: runA,
        deploymentId: DEPLOYMENT_ID,
        kind: "heartbeat",
        tenantId: TENANT,
        principalId: MEMBER_A,
        status: "running",
      },
      {
        id: runB,
        deploymentId: DEPLOYMENT_ID,
        kind: "heartbeat",
        tenantId: TENANT,
        principalId: MEMBER_B,
        status: "running",
      },
    ]);

    const credA = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: runA,
    });
    const credB = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: runB,
    });

    expect(credA.credentials.linear?.apiKey).toBe("linear-oauth-member-a");
    expect(credB.credentials.linear?.apiKey).toBe("linear-oauth-member-b");
  });

  test("member-only linear OAuth when no tenant credential is configured", async () => {
    await client.exec(`DELETE FROM credential WHERE id = 'cred-tenant-linear';`);

    const runId = "run-member-only";
    await db.insert(schema.workflowRunRecord).values({
      id: runId,
      deploymentId: DEPLOYMENT_ID,
      kind: "heartbeat",
      tenantId: TENANT,
      principalId: MEMBER_A,
      status: "running",
    });

    const body = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: runId,
    });

    expect(body.credentials.linear?.apiKey).toBe("linear-oauth-member-a");
  });

  test("unknown workflowRunId falls back to tenant credential (no member OAuth)", async () => {
    const body = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: "run-does-not-exist",
    });

    expect(body.credentials.linear?.apiKey).toBe("tenant-shared-linear-key");
  });

  test("provisioning run without deploymentId does not bind member OAuth for step agent", async () => {
    const runId = "run-provisioning-no-dep";
    await db.insert(schema.workflowRunRecord).values({
      id: runId,
      deploymentId: null,
      kind: "provisioning",
      tenantId: TENANT,
      principalId: MEMBER_A,
      status: "running",
    });

    const body = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: runId,
    });

    expect(body.credentials.linear?.apiKey).toBe("tenant-shared-linear-key");
    expect(body.credentials.linear?.apiKey).not.toBe("linear-oauth-member-a");
  });

  test("provisioning run without deploymentId cannot bind member OAuth to mismatched agentId", async () => {
    const mismatchedAgentId = "ins_ses_other-deployment-heartbeat-intake-linear";
    await db.insert(intxSchema.agent).values({
      id: mismatchedAgentId,
      tenantId: TENANT,
      creatorPrincipalId: MEMBER_B,
      name: "other-step",
      toolPackages: LINEAR_TOOL_PINS,
    });

    const runId = "run-provisioning-mismatched-agent";
    await db.insert(schema.workflowRunRecord).values({
      id: runId,
      deploymentId: null,
      kind: "provisioning",
      tenantId: TENANT,
      principalId: MEMBER_A,
      status: "running",
    });

    const body = await postCredentials({
      tenantId: TENANT,
      agentId: mismatchedAgentId,
      providerNames: ["linear"],
      workflowRunId: runId,
    });

    expect(body.credentials.linear?.apiKey).toBe("tenant-shared-linear-key");
    expect(body.credentials.linear?.apiKey).not.toBe("linear-oauth-member-a");
    expect(body.credentials.linear?.apiKey).not.toBe("linear-oauth-member-b");
  });

  test("mismatched workflowRunId and step agent deployment skips member path (tenant fallback)", async () => {
    const runId = "run-other-dep";
    await db.insert(schema.workflowRunRecord).values({
      id: runId,
      deploymentId: "ses_other-dep",
      kind: "heartbeat",
      tenantId: TENANT,
      principalId: MEMBER_A,
      status: "running",
    });

    const body = await postCredentials({
      tenantId: TENANT,
      agentId: STEP_AGENT_ID,
      providerNames: ["linear"],
      workflowRunId: runId,
    });

    expect(body.credentials.linear?.apiKey).toBe("tenant-shared-linear-key");
  });
});