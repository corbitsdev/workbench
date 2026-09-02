// CL-7366: prove the aligned routine and workflow-authoring paths end to
// end, against a real Postgres and a real hub+sidecar pair, driving only
// PUBLIC APIs (no seeded internal rows to fake success). Scenarios:
//
//   1. Bench-level routine create with no invited agent, targeting a
//      deployed definition discovered via `GET .../workflows/targets`;
//      a "run now" fire appears in the routine's own run listing.
//   2. Retarget: `PATCH /routines/:id` swaps `definitionAssetId` and
//      leaves every other field alone.
//   3. Fail-closed retarget: a made-up asset id, and an asset id that
//      is real but belongs to a different tenant, both 404.
//   4. Myra-shaped author -> preview -> deploy over the run-authenticated
//      `/api/workflow-workflow-authoring` surface: authoring an asset,
//      previewing its deploy (CL-7362's native preview seam is not wired
//      yet — the route answers a documented `unavailable` envelope,
//      asserted here rather than faked; see the inline note below),
//      deploying it directly (now a routine target, previously not),
//      and a wrong `expectedWireHash` on redeploy failing closed with
//      `wire_hash_mismatch`.
//   5. The routine run's own agent principal holds no `approval:*`
//      grant — approving a deploy is never something an agent can do
//      to itself.
//   6. The workflow detail route reports `deployed` for a live asset
//      and 404s for a bogus one.
//
// Approval of the `workflow_deploy` *tool call* itself (the `ask`-gated
// step a real Myra turn would hit before ever reaching the deploy route)
// is a runtime-approval concern exercised elsewhere; scenario 4 below
// calls the deploy route directly, the same way `packages/hub-client`'s
// seed and CL-7361's own route tests do.
import { describe, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../workflows/heartbeat/src/index.ts";
import {
  renderWorkflowSourceTree,
  WORKFLOW_SOURCE_ENTRY,
} from "../../packages/workflows/src/source.ts";
import {
  api,
  assertNeverRealProvider,
  connectE2eDb,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  pushWorkflowSource,
  workflowDeployBody,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "routine-alignment: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

function record(data: unknown, what: string): Record<string, unknown> {
  if (typeof data === "object" && data !== null) {
    return data as Record<string, unknown>;
  }
  throw new Error(`${what}: expected an object body: ${JSON.stringify(data)}`);
}

type RunAddress = { readonly address: string; readonly principalId: string };

/** Harness-side fact, matching `routine-trigger-input.test.ts`'s own
 * mailbox read: no public route exposes a run's own address by run id,
 * so this reads `workflow_run` straight out of Postgres to hand the
 * run-authenticated authoring surface the run bearer it expects. */
async function readRunAddress(url: string, runId: string): Promise<RunAddress> {
  const sql = await connectE2eDb(url);
  try {
    const rows = await sql.unsafe(
      `SELECT address, principal_id FROM workflow_run WHERE id = $1`,
      [runId],
    );
    const row = rows[0] as
      { address: unknown; principal_id: unknown } | undefined;
    if (row === undefined) {
      throw new Error(`no workflow_run row for run ${runId}`);
    }
    return {
      address: String(row.address),
      principalId: String(row.principal_id),
    };
  } finally {
    await sql.end();
  }
}

describe.skipIf(databaseUrl === undefined)(
  "aligned routine and workflow-authoring paths",
  () => {
    test("routine target/retarget, agent authoring/deploy, and fail-closed grants all hold end to end", async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await hop("database setup", async () => {
        await resetSchema(url);
        await setupDatabase(url);
      });

      const sidecarId = "sidecar-e2e-routine-alignment";
      const sidecarToken = crypto.randomUUID();
      await hop("sidecar provisioning", () =>
        provisionSidecar(url, sidecarId, sidecarToken),
      );

      const hub: HubHandle = await hop("hub boot", async () => {
        const handle = await startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("e2e-routine-alignment-hub-data-"),
        });
        track(handle);
        return handle;
      });

      const sidecar = await hop("sidecar boot", async () => {
        const app = startSidecar({
          hubPort: Number(new URL(hub.baseUrl).port),
          sidecarId,
          token: sidecarToken,
          dataDir: await tempDir("e2e-routine-alignment-sidecar-data-"),
        });
        track(app);
        return app;
      });

      const cookies = await hop("sign-up", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
          name: "Routine Alignment Tester",
          email: `routine-alignment-${crypto.randomUUID()}@example.invalid`,
          password: `pw-${crypto.randomUUID()}`,
        });
        expectStatus("sign-up", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-up returned no session cookie");
        }
        return res.cookies;
      });

      const slug = `e2era${crypto.randomUUID().slice(0, 8)}`;
      const tenantId = await hop("tenant creation", async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          "/api/tenants",
          { name: "Routine Alignment", slug },
          cookies,
        );
        expectStatus("create tenant", res, 201);
        return stringField(res.data, "id", "create tenant");
      });

      const noopBaseUrl = `${hub.baseUrl}/api/chat/noop-inference`;
      assertNeverRealProvider(noopBaseUrl, "noop catalog provider baseURL");
      await hop("noop catalog seeding", async () => {
        const model = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/models`,
          { canonicalName: "noop" },
          cookies,
        );
        expectStatus("create catalog model", model, 201);
        const modelId = stringField(model.data, "id", "create catalog model");

        const provider = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/providers`,
          { name: "anthropic", plugin: "anthropic" },
          cookies,
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
          cookies,
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
            baseURL: noopBaseUrl,
            credentialId,
          },
          cookies,
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
          cookies,
        );
        expectStatus("create catalog offering", offering, 201);
      });

      // --- publish + deploy two targets ("A" and "B") for the retarget
      // scenario ------------------------------------------------------
      async function publishAndDeployHeartbeat(
        assetName: string,
      ): Promise<string> {
        const created = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/assets`,
          { kind: "workflow", name: assetName },
          cookies,
        );
        expectStatus(`create workflow asset ${assetName}`, created, 201);
        const assetId = stringField(
          created.data,
          "id",
          `create workflow asset ${assetName}`,
        );

        const minted = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/git-tokens`,
          {
            name: `e2e-routine-alignment-push-${assetName}`,
            resource: "asset:*",
            refPattern: "**",
            actions: ["can_read", "can_push"],
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
          cookies,
        );
        expectStatus(`mint git token for ${assetName}`, minted, 201);

        const definition = buildHeartbeatWorkflow({
          triggerAddress: `${assetName}@${slug}.localhost`,
          inferencePreferences: [{ provider: "anthropic", model: "noop" }],
          turnTimeoutMs: 30_000,
        });
        const pushed = await pushWorkflowSource({
          baseUrl: hub.baseUrl,
          tenantId,
          assetName,
          tokenSecret: stringField(
            minted.data,
            "secret",
            `mint git token for ${assetName}`,
          ),
          workflowJson: serializeHeartbeatWorkflow(definition),
        });

        const body = workflowDeployBody({
          assetId,
          commitSha: pushed.commitSha,
          sourceId: `src-routine-alignment-${assetName}`,
          provider: "anthropic",
          baseURL: noopBaseUrl,
          apiKey: "noop",
          model: "noop",
        });
        assertNeverRealProvider(
          noopBaseUrl,
          `${assetName} deploy source baseURL`,
        );
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before ${assetName} deploy; output:\n${sidecar.output()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/workflows/deployments`,
            body,
            cookies,
          );
          if (res.status === 502) {
            if (Date.now() > deadline) {
              throw new Error(
                `sidecar never became deployable for ${assetName} (hub kept ` +
                  `answering 502): ${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
              );
            }
            await Bun.sleep(200);
            continue;
          }
          expectStatus(`deploy ${assetName}`, res, 201);
          break;
        }
        return assetId;
      }

      const targetAAssetId = await hop("publish + deploy target A", () =>
        publishAndDeployHeartbeat("heartbeat-a"),
      );
      const targetBAssetId = await hop("publish + deploy target B", () =>
        publishAndDeployHeartbeat("heartbeat-b"),
      );

      const workbenchId = await hop("delivery workbench creation", async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/chat/workbenches`,
          { kind: "workbench", name: "Routine alignment results" },
          cookies,
        );
        expectStatus("create delivery workbench", res, 201);
        return stringField(res.data, "id", "create delivery workbench");
      });

      // --- Scenario 1: bench-level routine, no invited agent, discovered
      // through the public target-picker route -------------------------
      const routineId = await hop(
        "scenario 1: create + run-now against a discovered target",
        async () => {
          const targets = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/workflows/targets`,
            undefined,
            cookies,
          );
          expectStatus("list routine targets", targets, 200);
          const items = record(targets.data, "list routine targets")[
            "items"
          ] as { definitionAssetId: string }[];
          const target = items.find(
            (item) => item.definitionAssetId === targetAAssetId,
          );
          if (target === undefined) {
            throw new Error(
              `target A (${targetAAssetId}) not offered by the routine ` +
                `target picker: ${JSON.stringify(targets.data)}`,
            );
          }

          const routine = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/routines`,
            {
              name: "Alignment routine",
              definitionAssetId: target.definitionAssetId,
              trigger: null,
              scope: "bench",
              deliveryWorkbenchId: workbenchId,
              input: { note: "CL-7366 alignment proof" },
            },
            cookies,
          );
          expectStatus("create bench routine", routine, 201);
          const id = stringField(routine.data, "id", "create bench routine");

          const fired = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/routines/${id}/run`,
            {},
            cookies,
          );
          expectStatus("run-now fire", fired, 201);
          const runId = stringField(fired.data, "runId", "run-now fire");

          const deadline = Date.now() + 30_000;
          for (;;) {
            const runs = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenantId}/routines/${id}/runs`,
              undefined,
              cookies,
            );
            expectStatus("list routine runs", runs, 200);
            const runItems = record(runs.data, "list routine runs")[
              "items"
            ] as { runId: string }[];
            if (runItems.some((item) => item.runId === runId)) break;
            if (Date.now() > deadline) {
              throw new Error(
                `run ${runId} never appeared in /routines/${id}/runs: ` +
                  JSON.stringify(runs.data),
              );
            }
            await Bun.sleep(200);
          }

          return id;
        },
      );

      // --- Scenario 2: retarget -----------------------------------------
      await hop(
        "scenario 2: retarget swaps only definitionAssetId",
        async () => {
          const before = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/routines/${routineId}`,
            undefined,
            cookies,
          );
          expectStatus("read routine before retarget", before, 200);
          const beforeBody = record(
            before.data,
            "read routine before retarget",
          );

          const patched = await api(
            hub.baseUrl,
            "PATCH",
            `/api/tenants/${tenantId}/routines/${routineId}`,
            { definitionAssetId: targetBAssetId },
            cookies,
          );
          expectStatus("retarget routine", patched, 200);
          const patchedBody = record(patched.data, "retarget routine");

          if (patchedBody["definitionAssetId"] !== targetBAssetId) {
            throw new Error(
              `retarget did not take: expected definitionAssetId ` +
                `${targetBAssetId}, got ${JSON.stringify(patchedBody["definitionAssetId"])}`,
            );
          }
          if (patchedBody["name"] !== beforeBody["name"]) {
            throw new Error(
              `retarget changed the routine's name: before ` +
                `${JSON.stringify(beforeBody["name"])}, after ${JSON.stringify(patchedBody["name"])}`,
            );
          }
          if (
            JSON.stringify(patchedBody["deliveryWorkbenchId"]) !==
            JSON.stringify(beforeBody["deliveryWorkbenchId"])
          ) {
            throw new Error(
              "retarget changed deliveryWorkbenchId, which the patch never named",
            );
          }
        },
      );

      // --- Scenario 3: fail-closed retargets -----------------------------
      await hop(
        "scenario 3: retarget fails closed on an unknown or foreign asset",
        async () => {
          const bogus = await api(
            hub.baseUrl,
            "PATCH",
            `/api/tenants/${tenantId}/routines/${routineId}`,
            { definitionAssetId: "not-a-real-asset-id" },
            cookies,
          );
          expectStatus("retarget to a made-up asset id", bogus, 404);

          const otherSlug = `e2era2${crypto.randomUUID().slice(0, 8)}`;
          const otherTenantId = await hop(
            "create a second tenant for the cross-tenant check",
            async () => {
              const res = await api(
                hub.baseUrl,
                "POST",
                "/api/tenants",
                { name: "Routine Alignment (other tenant)", slug: otherSlug },
                cookies,
              );
              expectStatus("create second tenant", res, 201);
              return stringField(res.data, "id", "create second tenant");
            },
          );
          const foreignAsset = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${otherTenantId}/assets`,
            { kind: "workflow", name: "foreign-target" },
            cookies,
          );
          expectStatus("create asset in the other tenant", foreignAsset, 201);
          const foreignAssetId = stringField(
            foreignAsset.data,
            "id",
            "create asset in the other tenant",
          );

          const crossTenant = await api(
            hub.baseUrl,
            "PATCH",
            `/api/tenants/${tenantId}/routines/${routineId}`,
            { definitionAssetId: foreignAssetId },
            cookies,
          );
          expectStatus("retarget to another tenant's asset", crossTenant, 404);
        },
      );

      // --- Scenario 4: Myra-shaped author -> preview -> deploy ----------
      const authoredAssetId = await hop(
        "scenario 4: run-authenticated author/preview/deploy",
        async () => {
          const scenario1Run = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/routines/${routineId}/runs`,
            undefined,
            cookies,
          );
          expectStatus("read routine runs for run bearer", scenario1Run, 200);
          const items = record(scenario1Run.data, "read routine runs")[
            "items"
          ] as { runId: string }[];
          const runId = items[0]?.runId;
          if (runId === undefined) {
            throw new Error(
              `routine ${routineId} has no fires to mint a run bearer from: ` +
                JSON.stringify(scenario1Run.data),
            );
          }
          const { address, principalId } = await readRunAddress(url, runId);

          const runHeaders: Record<string, string> = {
            authorization: `Bearer ${sidecarToken}`,
            "x-workflow-run-address": address,
            "content-type": "application/json",
          };

          // A real Myra deploy resolves its inference sources from the
          // tenant catalog server-side, and the write path (asset:*/create,
          // workflow:*/create) is gated the same as any other principal —
          // grant this run's own principal exactly those two, the same
          // way an operator would via the public grants route, so the
          // run-authenticated calls below exercise real authorization
          // rather than an ungated back door.
          for (const resource of ["asset:*", "workflow:*"]) {
            const granted = await api(
              hub.baseUrl,
              "POST",
              `/api/tenants/${tenantId}/grants`,
              {
                principalId,
                resource,
                action: "create",
                effect: "allow",
                origin: "system",
              },
              cookies,
            );
            expectStatus(
              `grant ${resource}/create to the routine's run`,
              granted,
              201,
            );
          }

          const definition = buildHeartbeatWorkflow({
            triggerAddress: `myra-authored@${slug}.localhost`,
            inferencePreferences: [{ provider: "anthropic", model: "noop" }],
            turnTimeoutMs: 30_000,
          });
          const files = renderWorkflowSourceTree({
            packageName: "myra-authored",
            workflowJson: serializeHeartbeatWorkflow(definition),
          });

          const authored = await fetch(
            `${hub.baseUrl}/api/workflow-workflow-authoring/author`,
            {
              method: "POST",
              headers: runHeaders,
              body: JSON.stringify({ name: "myra-authored", files }),
            },
          );
          const authoredData: unknown = await authored.json();
          if (authored.status !== 201) {
            throw new Error(
              `author: expected 201, got ${authored.status}: ${JSON.stringify(authoredData)}`,
            );
          }
          const authoredBody = record(
            record(authoredData, "author response")["data"],
            "author response data",
          );
          const assetId = stringField(
            authoredBody,
            "assetId",
            "author response",
          );
          const commitSha = stringField(
            authoredBody,
            "commitSha",
            "author response",
          );

          const preview = await fetch(
            `${hub.baseUrl}/api/workflow-workflow-authoring/${assetId}/deploy/preview`,
            {
              method: "POST",
              headers: runHeaders,
              body: JSON.stringify({ commitSha, entry: WORKFLOW_SOURCE_ENTRY }),
            },
          );
          const previewData: unknown = await preview.json();
          if (preview.status === 502) {
            // CL-7362 ("Preview: native probe with empty ApprovalSet, no
            // freeze") is not wired yet — `docs/workflow-source-authoring.md`
            // lists this seam under "Seams that do not exist yet" as of
            // this proof landing. The route answers a canonical
            // `unavailable` envelope rather than pretending to preview, so
            // this asserts exactly that fail-closed shape instead of a
            // real wireHash/grants preview, and the deploy below proceeds
            // without a preview-derived expectedWireHash.
            const previewError = record(
              record(previewData, "preview response")["error"],
              "preview error",
            );
            if (previewError["code"] !== "unavailable") {
              throw new Error(
                `deploy preview: expected the documented CL-7362 ` +
                  `"unavailable" envelope, got ${JSON.stringify(previewData)}`,
              );
            }
          } else if (preview.status !== 200 && preview.status !== 201) {
            throw new Error(
              `deploy preview: expected 200/201, got ${preview.status}: ${JSON.stringify(previewData)}`,
            );
          } else {
            const previewBody = record(
              record(previewData, "preview response")["data"],
              "preview response data",
            );
            stringField(previewBody, "wireHash", "preview response");
            if (!Array.isArray(previewBody["grants"])) {
              throw new Error(
                `preview response missing a grants array: ${JSON.stringify(previewData)}`,
              );
            }
          }

          const notYetTargets = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/workflows/targets`,
            undefined,
            cookies,
          );
          expectStatus("list targets before deploy", notYetTargets, 200);
          const notYetItems = record(
            notYetTargets.data,
            "list targets before deploy",
          )["items"] as { definitionAssetId: string }[];
          if (notYetItems.some((item) => item.definitionAssetId === assetId)) {
            throw new Error(
              `previewed-but-not-deployed asset ${assetId} already appears ` +
                "as a routine target",
            );
          }

          const deployed = await fetch(
            `${hub.baseUrl}/api/workflow-workflow-authoring/${assetId}/deploy`,
            {
              method: "POST",
              headers: runHeaders,
              body: JSON.stringify({ commitSha, entry: WORKFLOW_SOURCE_ENTRY }),
            },
          );
          const deployedData: unknown = await deployed.json();
          if (deployed.status !== 201) {
            throw new Error(
              `deploy: expected 201, got ${deployed.status}: ${JSON.stringify(deployedData)}`,
            );
          }

          const nowTargetsDeadline = Date.now() + 30_000;
          for (;;) {
            const nowTargets = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenantId}/workflows/targets`,
              undefined,
              cookies,
            );
            expectStatus("list targets after deploy", nowTargets, 200);
            const nowItems = record(
              nowTargets.data,
              "list targets after deploy",
            )["items"] as { definitionAssetId: string }[];
            if (nowItems.some((item) => item.definitionAssetId === assetId)) {
              break;
            }
            if (Date.now() > nowTargetsDeadline) {
              throw new Error(
                `deployed asset ${assetId} never appeared as a routine target: ` +
                  JSON.stringify(nowTargets.data),
              );
            }
            await Bun.sleep(200);
          }

          const wrongHash = await fetch(
            `${hub.baseUrl}/api/workflow-workflow-authoring/${assetId}/deploy`,
            {
              method: "POST",
              headers: runHeaders,
              body: JSON.stringify({
                commitSha,
                entry: WORKFLOW_SOURCE_ENTRY,
                expectedWireHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              }),
            },
          );
          const wrongHashData: unknown = await wrongHash.json();
          if (wrongHash.status !== 409) {
            throw new Error(
              `redeploy with a wrong expectedWireHash: expected 409, got ` +
                `${wrongHash.status}: ${JSON.stringify(wrongHashData)}`,
            );
          }
          const wrongHashError = record(
            wrongHashData,
            "wrong-expectedWireHash response",
          )["error"];
          const errorCode = record(
            wrongHashError,
            "wrong-expectedWireHash error",
          )["code"];
          if (errorCode !== "wire_hash_mismatch") {
            throw new Error(
              `redeploy with a wrong expectedWireHash: expected code ` +
                `"wire_hash_mismatch", got ${JSON.stringify(errorCode)}`,
            );
          }

          return { assetId, principalId };
        },
      ).then((result) => result.assetId);

      // --- Scenario 5: an agent principal cannot approve -----------------
      await hop(
        "scenario 5: the routine's own run principal holds no approval grant",
        async () => {
          const scenario1Run = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/routines/${routineId}/runs`,
            undefined,
            cookies,
          );
          expectStatus("read routine runs for grants check", scenario1Run, 200);
          const items = record(scenario1Run.data, "read routine runs")[
            "items"
          ] as { runId: string }[];
          const runId = items[0]?.runId;
          if (runId === undefined) {
            throw new Error("no routine run to resolve a principal from");
          }
          const { principalId } = await readRunAddress(url, runId);

          const grants = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/grants`,
            undefined,
            cookies,
          );
          expectStatus("list tenant grants", grants, 200);
          const rows = record(grants.data, "list tenant grants")["data"] as {
            principalId: string | null;
            resource: string;
            action: string;
            effect: string;
          }[];
          const approvalGrantForAgent = rows.find(
            (row) =>
              row.principalId === principalId &&
              row.resource.startsWith("approval") &&
              row.effect === "allow",
          );
          if (approvalGrantForAgent !== undefined) {
            throw new Error(
              `the routine's own run principal (${principalId}) holds an ` +
                `approval grant, which should never happen: ${JSON.stringify(approvalGrantForAgent)}`,
            );
          }
        },
      );

      // --- Scenario 6: the workflow detail route -------------------------
      await hop(
        "scenario 6: detail route reports deployed, 404s for a bogus id",
        async () => {
          const deployed = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/workflows/definitions/${authoredAssetId}/detail`,
            undefined,
            cookies,
          );
          expectStatus("read detail for the deployed asset", deployed, 200);
          const body = record(deployed.data, "detail response");
          if (body["lifecycle"] !== "deployed") {
            throw new Error(
              `expected lifecycle "deployed", got ${JSON.stringify(body["lifecycle"])}: ${JSON.stringify(deployed.data)}`,
            );
          }

          const bogus = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/workflows/definitions/not-a-real-asset-id/detail`,
            undefined,
            cookies,
          );
          expectStatus("read detail for a bogus asset id", bogus, 404);
        },
      );

      console.log(
        "routine-alignment: gate achieved: routine target discovery, " +
          "retarget (success and fail-closed), agent-authored author/" +
          "preview/deploy, deploy wire-hash fail-closed, agent-cannot-" +
          "approve, and the workflow detail route all hold end to end.",
      );
    }, 240_000);
  },
);
