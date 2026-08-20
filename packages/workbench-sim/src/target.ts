// Boots one real workbench stack (hub + sidecar + Postgres) for a sim
// run and provisions the scenario's cast: N signed-up humans in one
// tenant, agent definitions deployed and invited into a channel, and
// routines bound to a deployed definition. Mirrors the proven e2e
// boots (`scripts/e2e/routine-repeat.test.ts` for the zero-cost noop
// catalog + deploy, `scripts/e2e/chat.test.ts` for multi-principal
// membership and channel mechanics) without bun:test — cleanups are
// owned here, exactly like `packages/evals`' real target.
//
// Inference modes:
//   - "noop": every catalog/deploy source is pinned at the hub's own
//     noop-inference endpoint, so agent turns complete instantly with
//     zero network. This is the volume mode.
//   - "ollama": env-gated (OLLAMA_BASE_URL) quality sampling. Not
//     implemented yet — see cli.ts's honest refusal.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetSchema, setupDatabase } from "../../../scripts/db-setup.ts";
import {
  api,
  connectE2eDb,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  provisionSidecar,
  pushWorkflowJson,
  runCleanups,
  startHub,
  startSidecar,
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "../../../scripts/e2e/harness.ts";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "../../../workflows/echo/src/index.ts";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../../workflows/heartbeat/src/index.ts";
import type { Scenario } from "./scenario";

export type SimMode = "noop" | "ollama";

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

export interface SimActor {
  key: string;
  name: string;
  cookies: string[];
}

export interface SimAgent {
  key: string;
  address: string;
  handle: string;
}

export interface SimRoutine {
  key: string;
  id: string;
}

export interface SimStack {
  baseUrl: string;
  tenantId: string;
  channelId: string;
  actors: ReadonlyMap<string, SimActor>;
  agents: ReadonlyMap<string, SimAgent>;
  routines: ReadonlyMap<string, SimRoutine>;
  ownerCookies: string[];
  api: typeof api;
  countAllRows(): Promise<number>;
  sidecarExited(): boolean;
  close(): Promise<void>;
}

async function signUp(
  baseUrl: string,
  name: string,
): Promise<{ userId: string; email: string; cookies: string[] }> {
  const email = `sim-${crypto.randomUUID()}@example.invalid`;
  const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
    name,
    email,
    password: `pw-${crypto.randomUUID()}`,
  });
  expectStatus(`sign-up for ${name}`, res, 200);
  if (res.cookies.length === 0) {
    throw new Error(`sign-up for ${name} returned no session cookie`);
  }
  const userId = stringField(
    (res.data as { user: unknown }).user,
    "id",
    `sign-up user field for ${name}`,
  );
  return { userId, email, cookies: res.cookies };
}

async function deployWorkflow(options: {
  baseUrl: string;
  tenantId: string;
  cookies: string[];
  sidecar: SpawnedApp;
  assetName: string;
  workflowJson: string;
  noopBaseURL: string;
}): Promise<string> {
  const created = await api(
    options.baseUrl,
    "POST",
    `/api/tenants/${options.tenantId}/assets`,
    { kind: "workflow", name: options.assetName },
    options.cookies,
  );
  expectStatus(`create ${options.assetName} asset`, created, 201);
  const assetId = stringField(created.data, "id", "create asset");

  const minted = await api(
    options.baseUrl,
    "POST",
    `/api/tenants/${options.tenantId}/git-tokens`,
    {
      name: `sim-push-${options.assetName}`,
      resource: "asset:*",
      refPattern: "**",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    options.cookies,
  );
  expectStatus(`mint git token for ${options.assetName}`, minted, 201);

  await pushWorkflowJson({
    baseUrl: options.baseUrl,
    tenantId: options.tenantId,
    assetName: options.assetName,
    tokenSecret: stringField(minted.data, "secret", "mint git token"),
    workflowJson: options.workflowJson,
  });

  const sourceId = `src-sim-${options.assetName}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (options.sidecar.exited()) {
      throw new Error(
        `sidecar exited before ${options.assetName} deploy; output:\n${options.sidecar.output()}`,
      );
    }
    const res = await api(
      options.baseUrl,
      "POST",
      `/api/tenants/${options.tenantId}/workflows/deployments`,
      {
        assetId,
        sources: [
          {
            id: sourceId,
            provider: "anthropic",
            baseURL: options.noopBaseURL,
            apiKey: "noop",
            model: "noop",
          },
        ],
        defaultSource: sourceId,
      },
      options.cookies,
    );
    if (res.status !== 502) {
      expectStatus(`deploy ${options.assetName}`, res, 201);
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${options.assetName} never became deployable (502): sidecar output:\n${options.sidecar.output()}`,
      );
    }
    await Bun.sleep(1000);
  }

  // The deploy response carries no definition id; resolve it by name
  // off the definitions list, as routine-repeat does.
  const listed = await api(
    options.baseUrl,
    "GET",
    `/api/tenants/${options.tenantId}/workflows/definitions`,
    undefined,
    options.cookies,
  );
  expectStatus("list workflow definitions", listed, 200);
  const rows =
    typeof listed.data === "object" &&
    listed.data !== null &&
    "data" in listed.data
      ? (listed.data as { data: unknown[] }).data
      : (listed.data as unknown[]);
  const found = (rows as { id: string; name?: string }[]).find(
    (row) => row.name === options.assetName,
  );
  if (found === undefined) {
    throw new Error(
      `no workflow definition named "${options.assetName}": ${JSON.stringify(listed.data)}`,
    );
  }
  return found.id;
}

export async function bootSimStack(
  scenario: Scenario,
  mode: SimMode,
): Promise<SimStack> {
  if (mode !== "noop") {
    throw new Error(
      'bootSimStack: only "noop" mode is implemented; "ollama" quality ' +
        "sampling is a stubbed next step (see cli.ts)",
    );
  }
  const databaseUrl = e2eDatabaseUrl();
  if (databaseUrl === undefined) {
    throw new Error(
      "DATABASE_URL is not set; the sim needs a reachable Postgres (see .env.example)",
    );
  }

  const cleanups: (() => Promise<void>)[] = [];
  const close = () => runCleanups(cleanups);

  try {
    await resetSchema(databaseUrl);
    await setupDatabase(databaseUrl);

    const sidecarId = `sim-${crypto.randomUUID().slice(0, 8)}`;
    const sidecarToken = crypto.randomUUID();
    await provisionSidecar(databaseUrl, sidecarId, sidecarToken);

    const hubDataDir = await mkdtemp(path.join(tmpdir(), "sim-hub-data-"));
    cleanups.push(() => rm(hubDataDir, { recursive: true, force: true }));
    const hub: HubHandle = await startHub({
      databaseUrl,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: hubDataDir,
    });
    cleanups.push(() => hub.stop());

    const sidecarDataDir = await mkdtemp(
      path.join(tmpdir(), "sim-sidecar-data-"),
    );
    cleanups.push(() => rm(sidecarDataDir, { recursive: true, force: true }));
    const sidecar = startSidecar({
      hubPort: Number(new URL(hub.baseUrl).port || "80"),
      sidecarId,
      token: sidecarToken,
      dataDir: sidecarDataDir,
    });
    cleanups.push(() => sidecar.stop());

    const humanEntries = Object.entries(scenario.humans);
    const first = humanEntries[0];
    if (first === undefined) {
      throw new Error("scenario declares no humans");
    }
    const [ownerKey, ownerName] = first;
    const owner = await signUp(hub.baseUrl, ownerName);

    const slug = `sim${crypto.randomUUID().slice(0, 8)}`;
    const tenantRes = await api(
      hub.baseUrl,
      "POST",
      "/api/tenants",
      { name: `Sim: ${scenario.name}`, slug },
      owner.cookies,
    );
    expectStatus("create tenant", tenantRes, 201);
    const tenantId = stringField(tenantRes.data, "id", "create tenant");

    const actors = new Map<string, SimActor>();
    actors.set(ownerKey, {
      key: ownerKey,
      name: ownerName,
      cookies: owner.cookies,
    });

    for (const [key, name] of humanEntries.slice(1)) {
      const member = await signUp(hub.baseUrl, name);
      const invited = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/members/invite`,
        { email: member.email },
        owner.cookies,
      );
      expectStatus(`invite ${name}`, invited, 201);
      const principalId = stringField(invited.data, "id", `invite ${name}`);
      const activated = await api(
        hub.baseUrl,
        "PATCH",
        `/api/tenants/${tenantId}/principals/${principalId}`,
        { status: "active" },
        owner.cookies,
      );
      expectStatus(`activate ${name}`, activated, 200);
      for (const action of ["read", "write", "create"]) {
        const grant = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/grants`,
          {
            principalId,
            resource: "workflow-run:*",
            action,
            effect: "allow",
            origin: "creator",
          },
          owner.cookies,
        );
        expectStatus(`grant workflow-run:*/${action} to ${name}`, grant, 201);
      }
      actors.set(key, { key, name, cookies: member.cookies });
    }

    const noopBaseURL = `${hub.baseUrl}/api/chat/noop-inference`;

    // The zero-cost catalog chain agent launches resolve against —
    // identical to routine-repeat's "noop catalog seeding".
    const model = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/catalog/models`,
      { canonicalName: "noop" },
      owner.cookies,
    );
    expectStatus("create catalog model", model, 201);
    const modelId = stringField(model.data, "id", "create catalog model");
    const provider = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/providers`,
      { name: "anthropic", plugin: "anthropic" },
      owner.cookies,
    );
    expectStatus("create provider", provider, 201);
    const providerId = stringField(provider.data, "id", "create provider");
    const credential = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/credentials`,
      {
        providerId,
        name: "anthropic-default",
        type: "api_key",
        secret: "noop",
      },
      owner.cookies,
    );
    expectStatus("create credential", credential, 201);
    const credentialId = stringField(
      credential.data,
      "id",
      "create credential",
    );
    const catalogProvider = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/catalog/providers`,
      {
        name: "anthropic",
        plugin: "anthropic",
        baseURL: noopBaseURL,
        credentialId,
      },
      owner.cookies,
    );
    expectStatus("create catalog provider", catalogProvider, 201);
    const catalogProviderId = stringField(
      catalogProvider.data,
      "id",
      "create catalog provider",
    );
    const offering = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/catalog/offerings`,
      { modelId, providerId: catalogProviderId },
      owner.cookies,
    );
    expectStatus("create catalog offering", offering, 201);

    const domain = stringField(tenantRes.data, "domain", "create tenant");
    const echoDefinitionId = await deployWorkflow({
      baseUrl: hub.baseUrl,
      tenantId,
      cookies: owner.cookies,
      sidecar,
      assetName: "echo",
      workflowJson: serializeEchoWorkflow(
        buildEchoWorkflow({
          triggerAddress: `echo@${domain}`,
          inferencePreferences: [{ provider: "anthropic", model: "noop" }],
          turnTimeoutMs: 60_000,
        }),
      ),
      noopBaseURL,
    });
    const heartbeatDefinitionId = await deployWorkflow({
      baseUrl: hub.baseUrl,
      tenantId,
      cookies: owner.cookies,
      sidecar,
      assetName: "heartbeat",
      workflowJson: serializeHeartbeatWorkflow(
        buildHeartbeatWorkflow({
          triggerAddress: `heartbeat@${domain}`,
          inferencePreferences: [{ provider: "anthropic", model: "noop" }],
          turnTimeoutMs: 30_000,
        }),
      ),
      noopBaseURL,
    });

    // Channel creation launches the anchor in-process; retried through
    // 500 until the sidecar dial-in completes (chat.test.ts pattern).
    let channelRes: ApiResult;
    const channelDeadline = Date.now() + 60_000;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before channel creation; output:\n${sidecar.output()}`,
        );
      }
      channelRes = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/chat/channels`,
        { kind: "channel", name: "general" },
        owner.cookies,
      );
      if (channelRes.status !== 500) break;
      if (Date.now() > channelDeadline) {
        throw new Error(
          `channel never became launchable: ${JSON.stringify(channelRes.data)}\nsidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
    expectStatus("create channel", channelRes, 201);
    const channelId = stringField(channelRes.data, "id", "create channel");

    const agents = new Map<string, SimAgent>();
    for (const agentSpec of scenario.agents) {
      if (agentSpec.workflow !== "echo") {
        throw new Error(`unsupported agent workflow: ${agentSpec.workflow}`);
      }
      const invited = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/chat/channels/${channelId}/invite`,
        { definitionId: echoDefinitionId },
        owner.cookies,
      );
      expectStatus(`invite agent ${agentSpec.key}`, invited, 201);
      const address = stringField(invited.data, "address", "invite agent");
      const local = address.split("@")[0] ?? address;
      agents.set(agentSpec.key, { key: agentSpec.key, address, handle: local });
    }

    const routines = new Map<string, SimRoutine>();
    for (const routineSpec of scenario.routines) {
      if (routineSpec.workflow !== "heartbeat") {
        throw new Error(
          `unsupported routine workflow: ${routineSpec.workflow}`,
        );
      }
      const created = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/routines`,
        {
          name: routineSpec.name,
          definitionId: heartbeatDefinitionId,
          trigger: { kind: "interval", unit: "hours", every: 24 },
          scope: "bench",
          deliveryChannelId: channelId,
        },
        owner.cookies,
      );
      expectStatus(`create routine ${routineSpec.key}`, created, 201);
      routines.set(routineSpec.key, {
        key: routineSpec.key,
        id: stringField(created.data, "id", "create routine"),
      });
    }

    const sql = await connectE2eDb(databaseUrl);
    cleanups.push(() => sql.end());

    async function countAllRows(): Promise<number> {
      const tables = await sql.unsafe(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type = 'BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );
      let total = 0;
      for (const table of tables) {
        const rows = await sql.unsafe(
          `SELECT count(*)::int AS n FROM "${String(table["table_schema"])}"."${String(table["table_name"])}"`,
        );
        total += Number(rows[0]?.["n"] ?? 0);
      }
      return total;
    }

    return {
      baseUrl: hub.baseUrl,
      tenantId,
      channelId,
      actors,
      agents,
      routines,
      ownerCookies: owner.cookies,
      api,
      countAllRows,
      sidecarExited: () => sidecar.exited(),
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}
