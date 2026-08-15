// CL-6055 phase A: the scripted onboard→connect leg of the local-rip
// proof — everything a brand-new person does before ever touching a
// task. One sequential scenario against a real hub, a real sidecar,
// and a real Postgres: closed-by-default signup is respected → sign
// up → first-login provisioning mints a personal bench, unseeded (no
// hub-owned seed model) → connecting a real inference credential
// through the key path (`POST /api/onboarding/complete`'s own
// machinery, called directly — see the stubbing note below) fully
// seeds every default workflow, including "assistant" → the
// Connections surface (the tenant's own credentials list, the same
// route `connectorStatus` in `@workbench/settings-ui` reads) honestly
// reflects the connected credential. Phase B (once CL-6049's task leg
// merges) appends the task leg at the marked point at the bottom of
// this scenario; this file proves onboarding→connect only.
//
// Until CL-6057, this suite documented a real platform gap instead of
// hiding it: the "assistant" default workflow pins
// `@corbits/memory-tools`, and that pin only resolved once an operator
// had published a `package-registry`-kind asset named "corbits-tools"
// carrying its tarball. `seedTenant` now publishes that asset itself
// (`@corbits/tool-registry-publish`, wired in at
// `packages/hub-client/src/seed.ts`) ahead of deploying any workflow,
// so this suite asserts a full seed rather than a documented skip.
//
// Stubbing note: proving a pasted key means an outbound call to the
// provider's own auth layer (`testProviderCredential`, hit through
// `apps/hub`'s `POST /api/onboarding/complete` route with no override
// seam). This suite never reaches that route — it drives the same
// two halves the route itself calls
// (`testAndPersistCredential`/`ensureSeeded`, both from
// `@workbench/onboarding`'s `complete-credential.ts`) directly, the
// same way `chat.test.ts` drives `seedCatalog` directly rather than
// going through an HTTP surface that has no test seam. Every other
// call these two halves make is real HTTP against the spawned hub;
// only `testAndPersistCredential`'s own `testCredential` argument —
// the seam that module's header comment documents existing precisely
// so an OAuth callback route can run only the fast half — is stubbed,
// to a fixed `{ ok: true }`, so this suite never dials a real
// provider. The stubbed key itself is never sent anywhere: the
// resulting deployments carry it as a stored, never-triggered source
// (`confirmDeployments: false`, matching onboarding's own connect
// flow — see `ensureSeeded`'s doc comment), so a made-up key is exactly
// as good as a real one for proving this leg.
//
// The deployed sources' `baseURL` is the real Anthropic host
// (`CATALOG_SEEDS`), which is the honest key-path behavior — this
// suite deliberately does not run those sources through
// `assertNeverRealProvider`, since flagging a real provider host here
// would be a false positive: it is never called, only stored.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createGitWorkflowPusher,
  createHubAPI,
  DEFAULT_WORKFLOWS,
  isLiveDeploymentStatus,
  parseAs,
  seedTenant,
  type ApiCall,
} from "../../packages/hub-client/src/index.ts";
import {
  findPersonalTenant,
  testAndPersistCredential,
  ensureSeeded,
  modelSourceFor,
} from "../../packages/onboarding/src/complete-credential.ts";
import {
  CredentialResponse,
  paginatedSchema,
} from "../../vendor/intx/types/src/index.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "local-rip: DATABASE_URL is not set; suite skipped. Set DATABASE_URL " +
      "(see .env.example) to run it; CI sets E2E_REQUIRED=1 so this skip " +
      "can never pass silently there.",
  );
}

// A key that is never sent anywhere: the probe that would normally
// prove it is stubbed below, and the deployments it seeds are never
// triggered. Named so it can never be mistaken for a real secret if it
// leaks into a log line or a bug report.
const STUB_API_KEY = "e2e-local-rip-stub-key-not-real";

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

async function signUp(
  baseUrl: string,
  name: string,
): Promise<{ userId: string; email: string; cookies: string[] }> {
  const email = `local-rip-${crypto.randomUUID()}@example.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
    name,
    email,
    password,
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

describe.skipIf(databaseUrl === undefined)(
  "local-rip: onboard → connect",
  () => {
    test("a brand-new person signs up, gets a personal bench, and connects a real provider through the key path", async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await hop("database setup", async () => {
        await resetSchema(url);
        const report = await setupDatabase(url);
        expect(report.action).toBe("migrated");
      });

      // Closed-by-default: a hub with no WORKBENCH_SIGNUP override (the
      // platform's own default, per `apps/hub/src/config.ts`) refuses a
      // brand-new person outright, right at sign-up — the access-policy
      // gate is wired into better-auth's own sign-up hook, one layer
      // earlier than onboarding's own provisioning gate — proven against
      // a short-lived hub of its own so the rest of this scenario's hub
      // (which needs open signup to run at all) never muddies the
      // assertion.
      await hop("closed-by-default signup is respected", async () => {
        const closedHub = await startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("e2e-local-rip-closed-hub-data-"),
          extraEnv: { WORKBENCH_SIGNUP: "closed" },
        });
        try {
          const res = await api(
            closedHub.baseUrl,
            "POST",
            "/api/auth/sign-up/email",
            {
              name: "Closed Signup Tester",
              email: `local-rip-closed-${crypto.randomUUID()}@example.invalid`,
              password: `pw-${crypto.randomUUID()}`,
            },
          );
          expectStatus("closed-signup sign-up attempt", res, 403);
          const body = res.data as { error: string };
          expect(body.error).toBe("signup_closed");
        } finally {
          await closedHub.stop();
        }
      });

      const sidecarId = "local-rip-sidecar";
      const sidecarToken = crypto.randomUUID();
      await provisionSidecar(url, sidecarId, sidecarToken);

      const hub: HubHandle = await hop("hub boot", async () =>
        startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("e2e-local-rip-hub-data-"),
          // Deliberately no ANTHROPIC_API_KEY: like `smoke-onboarding`,
          // this hub carries no hub-owned seed model credential, so
          // first-login provisioning must report the bench as
          // provisioned-but-unseeded — this scenario's own connect step
          // is what finishes seeding it.
        }),
      );
      track(hub);

      const sidecar = startSidecar({
        hubPort: new URL(hub.baseUrl).port
          ? Number(new URL(hub.baseUrl).port)
          : 80,
        sidecarId,
        token: sidecarToken,
        dataDir: await tempDir("e2e-local-rip-sidecar-data-"),
      });
      track(sidecar);

      const hubApi: ApiCall = createHubAPI(hub.baseUrl);

      const user = await hop("sign-up", () =>
        signUp(hub.baseUrl, "Local Rip Tester"),
      );

      await hop(
        "a membership probe before naming reports needs-onboarding",
        async () => {
          const res = await api(
            hub.baseUrl,
            "POST",
            "/api/onboarding/provision",
            undefined,
            user.cookies,
          );
          expectStatus("provision probe", res, 200);
          expect((res.data as { kind: string }).kind).toBe("needs-onboarding");
        },
      );

      const provisioned = await hop(
        "first-login provisioning mints a personal bench, unseeded",
        async () => {
          const res = await api(
            hub.baseUrl,
            "POST",
            "/api/onboarding/provision",
            { name: "Local Rip Tester's Bench" },
            user.cookies,
          );
          expectStatus("provision", res, 200);
          const data = res.data as {
            kind: string;
            tenantId: string;
            tenantSlug: string;
            seeded: boolean;
            seedSkipReason?: string;
          };
          expect(data.kind).toBe("provisioned");
          expect(data.seeded).toBe(false);
          expect(typeof data.seedSkipReason).toBe("string");
          return data;
        },
      );

      await hop(
        "the provisioned bench is a real tenant membership",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            "/api/me/principals",
            undefined,
            user.cookies,
          );
          expectStatus("list principals", res, 200);
          const rows = (res.data as { data: { tenantId: string }[] }).data;
          const own = rows.find((row) => row.tenantId === provisioned.tenantId);
          if (own === undefined) {
            throw new Error(
              `provisioned tenant ${provisioned.tenantId} is missing from the caller's own principals: ${JSON.stringify(rows)}`,
            );
          }
        },
      );

      const tenant = await hop(
        "the freshly provisioned bench resolves through findPersonalTenant",
        async () => {
          const found = await findPersonalTenant(
            hubApi,
            user.cookies,
            provisioned.tenantSlug,
          );
          if (found === undefined) {
            throw new Error(
              `findPersonalTenant found nothing for slug ${provisioned.tenantSlug}`,
            );
          }
          expect(found.tenantId).toBe(provisioned.tenantId);
          return found;
        },
      );

      const pushWorkflow = createGitWorkflowPusher();

      const connected = await hop(
        "connecting a real inference credential via the key path (provider probe stubbed)",
        async () => {
          const result = await testAndPersistCredential({
            api: hubApi,
            cookies: user.cookies,
            hubUrl: hub.baseUrl,
            userId: user.userId,
            userEmail: user.email,
            provider: "anthropic",
            apiKey: STUB_API_KEY,
            pushWorkflow,
            log: () => undefined,
            // The one stubbed HTTP boundary in this scenario — see the
            // module header comment for why.
            testCredential: async () => ({ ok: true }),
          });
          if (result.kind !== "connected") {
            throw new Error(
              `expected the key-path connect to succeed, got: ${JSON.stringify(result)}`,
            );
          }
          expect(result.tenantId).toBe(tenant.tenantId);
          return result;
        },
      );

      // The deploy step needs the sidecar's dial-in to have completed —
      // ensureSeeded's own deployment call answers 502 until it has,
      // and (unlike the native workflow-deploy route the walking
      // skeleton retries directly) that 502 surfaces as a thrown
      // CliError rather than a response this suite can branch on. Every
      // step ensureSeeded/seedTenant takes is itself ensure-then-create,
      // so retrying the whole call is safe.
      async function deploySeededWorkflows(
        workflows: typeof DEFAULT_WORKFLOWS,
      ): Promise<Awaited<ReturnType<typeof seedTenant>>> {
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before default workflows could deploy; output:\n${sidecar.output()}`,
            );
          }
          try {
            return await seedTenant({
              api: hubApi,
              cookies: user.cookies,
              hubUrl: hub.baseUrl,
              tenant: {
                tenantId: tenant.tenantId,
                principalId: tenant.principalId,
                domain: tenant.tenantDomain,
              },
              model: modelSourceFor("anthropic", STUB_API_KEY),
              pushWorkflow,
              log: () => undefined,
              workflows,
              confirmDeployments: false,
            });
          } catch (cause) {
            if (Date.now() > deadline) throw cause;
            await Bun.sleep(1000);
          }
        }
      }

      // CL-6057 closed the platform gap the earlier version of this
      // suite documented: `seedTenant` (via `ensureSeeded`) now
      // publishes the tenant's `corbits-tools` package-registry asset
      // — packing `@corbits/memory-tools` into a self-contained
      // tarball through `@corbits/tool-registry-publish` — ahead of
      // deploying any workflow, so the "assistant" default workflow's
      // `@corbits/memory-tools` pin resolves instead of failing the
      // closure resolver with "unknown registry". This hop proves the
      // real, unmodified connect flow fully seeds a fresh bench: every
      // default workflow deploys, with none skipped.
      await hop(
        "the real, unmodified connect flow fully seeds every default workflow, including 'assistant'",
        async () => {
          const deadline = Date.now() + 60_000;
          for (;;) {
            if (sidecar.exited()) {
              throw new Error(
                `sidecar exited before ensureSeeded could run; output:\n${sidecar.output()}`,
              );
            }
            try {
              await ensureSeeded({
                api: hubApi,
                cookies: user.cookies,
                hubUrl: hub.baseUrl,
                pushWorkflow,
                log: () => undefined,
                tenant: connected,
                provider: "anthropic",
                apiKey: STUB_API_KEY,
              });
              break;
            } catch (cause) {
              if (Date.now() > deadline) throw cause;
              await Bun.sleep(1000);
            }
          }
        },
      );

      await hop(
        "every default workflow — echo, channel-digest, and assistant — deploys and goes live",
        async () => {
          await deploySeededWorkflows(DEFAULT_WORKFLOWS);
          for (const workflow of DEFAULT_WORKFLOWS) {
            const assetsRes = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenant.tenantId}/assets?kind=workflow&inherited=false`,
              undefined,
              user.cookies,
            );
            expectStatus(
              `list assets for ${workflow.assetName}`,
              assetsRes,
              200,
            );
            const assets = assetsRes.data as { id: string; name: string }[];
            const asset = assets.find((a) => a.name === workflow.assetName);
            if (asset === undefined) {
              throw new Error(`no asset named ${workflow.assetName}`);
            }
            const deploymentsRes = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenant.tenantId}/workflows/deployments`,
              undefined,
              user.cookies,
            );
            expectStatus(
              `list deployments for ${workflow.assetName}`,
              deploymentsRes,
              200,
            );
            const deployments = deploymentsRes.data as {
              definitionAssetId: string;
              status: string;
            }[];
            const live = deployments.find(
              (d) =>
                d.definitionAssetId === asset.id &&
                isLiveDeploymentStatus(d.status),
            );
            if (live === undefined) {
              throw new Error(
                `no live deployment for ${workflow.assetName}: ${JSON.stringify(deployments)}`,
              );
            }
          }
        },
      );

      await hop(
        "the Connections surface reflects the connected credential",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/credentials`,
            undefined,
            user.cookies,
          );
          expectStatus("list tenant credentials", res, 200);
          const credentials = parseAs(
            paginatedSchema(CredentialResponse),
            res.data,
            "credentials response",
          ).data;
          // `inferenceCredentialName("anthropic")` per
          // `@workbench/hub-client`'s `seed.ts` — the same name
          // `seedCatalog`'s `ensureCredential` call plants, and the same
          // one `connectorStatus` (`@workbench/settings-ui`) cross-
          // references a connector card's provider row against.
          const planted = credentials.find(
            (credential) => credential.name === "anthropic-default",
          );
          if (planted === undefined) {
            throw new Error(
              `no "anthropic-default" credential on the tenant's Connections surface: ${JSON.stringify(credentials)}`,
            );
          }
          expect(planted.status).toBe("active");
          expect(planted.type).toBe("api_key");
        },
      );

      // --- phase B appends the task leg here (CL-6055, once CL-6049 merges) ---
    }, 180_000);
  },
);
