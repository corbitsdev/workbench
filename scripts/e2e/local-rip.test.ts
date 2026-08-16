// CL-6055: the scripted local-rip proof — everything a brand-new
// person does from sign-up through their first dispatched task. One
// sequential scenario against a real hub, a real sidecar, and a real
// Postgres.
//
// Phase A (onboard → connect): closed-by-default signup is respected
// → sign up → first-login provisioning mints a personal bench,
// unseeded (no hub-owned seed model) → connecting a real inference
// credential through the key path (`POST /api/onboarding/complete`'s
// own machinery, called directly — see the stubbing note below) fully
// seeds every default workflow, including "assistant" → the
// Connections surface (the tenant's own credentials list, the same
// route `connectorStatus` in `@workbench/settings-ui` reads) honestly
// reflects the connected credential.
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
// Stubbing note: onboarding's own `POST /api/onboarding/complete` route
// (`testAndPersistCredential`, from `@workbench/onboarding`'s
// `complete-credential.ts`) stores a pasted key immediately, with no
// live probe of the provider gating it (CL-6123) — so there is nothing
// left to stub there. This suite still drives the same two halves the
// route itself calls (`testAndPersistCredential`/`ensureSeeded`)
// directly rather than through HTTP, the same way `chat.test.ts` drives
// `seedCatalog` directly rather than going through an HTTP surface that
// has no test seam. Every call these two halves make is real HTTP
// against the spawned hub, and no provider is ever dialed during phase
// A: the resulting deployments carry the stub key as a stored,
// never-triggered source (`confirmDeployments: false`, matching
// onboarding's own connect flow — see `ensureSeeded`'s doc comment), so
// a made-up key is exactly as good as a real one for proving that leg.
//
// The deployed sources' `baseURL` is the real Anthropic host
// (`CATALOG_SEEDS`), which is the honest key-path behavior — phase A
// deliberately does not run those sources through
// `assertNeverRealProvider`, since flagging a real provider host here
// would be a false positive: it is never called, only stored.
//
// Phase B (CL-6055, the task leg): what a person does after Cmd/Ctrl+T
// — dispatch a task at the seeded, taskable "echo" agent through
// `@corbits/tasks`'s real HTTP routes (packages/tasks/src/routes.ts),
// drive it to a terminal state, and prove creator-only privacy. Unlike
// phase A, this leg does make one real, secret-free outbound call: a
// task's opening turn genuinely dials the connected credential's real
// Anthropic host with the stub key from phase A, exactly the way
// `chat.test.ts`'s echo-invite test already does with a placeholder
// credential ("its own reply attempt errors, which is expected and
// irrelevant to this assertion" — see that test's own comment). A
// stub key is not a secret — nothing this suite sends is ever valid —
// so this stays a zero-secret suite; it is simply no longer a
// zero-network-call one. The host's real 401 classifies as
// `credential_failure` (`vendor/intx/inference/src/errors.ts`), which
// the inference harness turns into a completed turn carrying a
// self-describing credential-error report, rather than failing the
// run's own bracket — so the task's terminal status is "done", not
// "failed" (empirically confirmed, not assumed: see the task leg's
// own comments below for the exact delivered body). This is the one
// deterministic terminal outcome a stub credential dialing a real
// host produces; the leg asserts it honestly, by checking the
// delivered body names the credential error, rather than treating any
// terminal status as good enough.
//
// IMPORTANT: this "done" carries a credential-error report, not a real
// reply — an artifact of the stub key, not a platform defect. Swap the
// stub for a real, working credential (the local, no-shortcuts
// walkthrough in docs/local-rip.md does exactly that) and the
// identical task dispatch, terminal-poll, and inbox-delivery machinery
// this leg exercises completes the same run "done" with a real reply
// instead. Nothing below should be read as "tasks are broken"; it
// proves the dispatch → terminal-state → inbox-delivery → privacy path
// end to end, with the one leg (the model call itself) this suite
// cannot make real without a paid key standing in for its own honest,
// self-reported failure.
//
// Phase C (CL-6055, the trace and planner legs) closes out the rest of
// the /goal ladder in the same scripted pass:
//
//   - the trace leg proves the task→trace click-path server-side: the
//     dispatched task's run is readable through Insights' real trace
//     route (packages/insights/src/trace-reader.ts, over the platform's
//     own inference_turn/turn_part rows — no new storage) with real
//     span rows, while CL-6061's scoped top-level-runs listing
//     (packages/folded-runs/src/scope-routes.ts) never surfaces it, the
//     same "genuine top-level runs only" contract the Insights landing
//     page's own feed relies on.
//   - the planner leg proves "Let Myra choose" (the Cmd/Ctrl+T
//     composer's other path alongside manually picking an agent —
//     packages/tasks-ui/src/myra-agent-selection-strategy.tsx) fails
//     closed against the same stub credential: Myra's own one-shot run
//     draws the identical real 401 the task leg's opening turn does,
//     which `runPlanner` can only ever read as an unparseable reply, so
//     `@corbits/task-planner`'s route (packages/task-planner/src/
//     routes.ts) answers the honest `planning_failed` 422 it's built
//     for — never a task row, an agent definition, or an Inbox
//     delivery. A real key instead yields a valid `TaskSpec` and a real
//     dispatch, mirroring this suite's phase-A/B stub-key honesty
//     convention throughout.

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
import { CredentialResponse, paginatedSchema } from "@intx/types";
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

// A key that is never sent anywhere: onboarding never probes it (see
// the stubbing note above), and the deployments it seeds are never
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
  "local-rip: onboard → connect → task",
  () => {
    test("a brand-new person signs up, gets a personal bench, connects a real provider through the key path, and dispatches a task", async () => {
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
        "connecting a real inference credential via the key path (no provider probe — CL-6123)",
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

      // --- Phase B: the task dispatch leg (CL-6055) ---

      const echoDefinitionId = await hop(
        "the seeded echo agent is discoverable as a workflow definition",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/workflows/definitions`,
            undefined,
            user.cookies,
          );
          expectStatus("list workflow definitions", res, 200);
          const rows = (
            res.data as {
              data: { id: string; name: string; status: string }[];
            }
          ).data;
          const echo = rows.find((row) => row.name === "echo");
          if (echo === undefined) {
            throw new Error(
              `no "echo" workflow definition on the tenant: ${JSON.stringify(rows)}`,
            );
          }
          expect(echo.status).toBe("deployed");
          return echo.id;
        },
      );

      // A second principal, invited and explicitly granted `task:*`
      // read — so the privacy check below proves `@corbits/tasks`'s
      // own ownership filter (routes.ts: a colleague's task 404s, it
      // never 403s, so the response never leaks that the task exists),
      // not merely the absence of a grant.
      const outsider = await hop(
        "a second principal is invited, activated, and granted task read access",
        async () => {
          const email = `local-rip-outsider-${crypto.randomUUID()}@example.invalid`;
          const password = `pw-${crypto.randomUUID()}`;
          const signedUp = await api(
            hub.baseUrl,
            "POST",
            "/api/auth/sign-up/email",
            { name: "Local Rip Outsider", email, password },
          );
          expectStatus("outsider sign-up", signedUp, 200);
          if (signedUp.cookies.length === 0) {
            throw new Error("outsider sign-up returned no session cookie");
          }

          const invited = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/members/invite`,
            { email },
            user.cookies,
          );
          expectStatus("invite outsider", invited, 201);
          const principalId = stringField(
            invited.data,
            "id",
            "invite outsider",
          );

          const activated = await api(
            hub.baseUrl,
            "PATCH",
            `/api/tenants/${tenant.tenantId}/principals/${principalId}`,
            { status: "active" },
            user.cookies,
          );
          expectStatus("activate outsider", activated, 200);

          const granted = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/grants`,
            {
              principalId,
              resource: "task:*",
              action: "read",
              effect: "allow",
              origin: "creator",
            },
            user.cookies,
          );
          expectStatus("grant task read to outsider", granted, 201);

          return { cookies: signedUp.cookies };
        },
      );

      const launched = await hop(
        "creating a task through the real HTTP route launches it against the seeded echo agent",
        async () => {
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/tasks`,
            {
              definitionId: echoDefinitionId,
              prompt: `local-rip task leg ${crypto.randomUUID()}`,
            },
            user.cookies,
          );
          expectStatus("create task", res, 201);
          const item = (res.data as { item: Record<string, unknown> }).item;
          const id = stringField(item, "id", "create task");
          const runId = stringField(item, "runId", "create task");
          // `launchTask`'s own HTTP response only proves the opening
          // prompt was accepted by the session — the run's own inference
          // turn (and its terminal outcome) is still in flight.
          expect(item.status).toBe("running");
          return { id, runId };
        },
      );

      // The tenant's connected credential is the phase-A stub key
      // against the real Anthropic host (see this file's header
      // comment), so this run's opening turn draws a real 401. The
      // inference harness reports that gracefully rather than failing
      // the run's own bracket: the turn still completes, with a
      // self-describing credential-error report standing in for a
      // reply, so `message.run.ended` carries `status: "completed"`
      // and the task's own terminal status is "done" — empirically
      // confirmed against this exact stub key, not assumed. ("failed"
      // is still reachable — the opening prompt itself failing to
      // send, in `launcher.ts`, or a run whose own bracket genuinely
      // ends `status: "failed"` — just not by this path.) What proves
      // this "done" is the honest stub-key artifact, not a masked
      // platform bug, is the delivered body itself: a real credential
      // in the same seat produces a real reply here instead of a
      // credential-error report.
      const terminal = await hop(
        "the task reaches a terminal state — 'done', with a delivered body honestly reporting the phase-A stub credential's real 401 against the real Anthropic host",
        async () => {
          const deadline = Date.now() + 30_000;
          for (;;) {
            const res = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenant.tenantId}/tasks/${launched.id}`,
              undefined,
              user.cookies,
            );
            expectStatus("get task", res, 200);
            const item = (res.data as { item: Record<string, unknown> }).item;
            // The orchestrator flips `status` (`completeTask`) before it
            // records the delivered mail id (`recordResultMail`) — see
            // orchestrator.ts's `deliverTerminalTask` — so a terminal
            // status can briefly precede a populated `resultMailId`.
            // Keep polling through that gap rather than treating it as
            // a failure.
            const resultMailId = item.resultMailId;
            if (
              (item.status === "done" || item.status === "failed") &&
              typeof resultMailId === "string" &&
              resultMailId !== ""
            ) {
              expect(item.status).toBe("done");
              expect(item.runId).toBe(launched.runId);
              return { resultMailId };
            }
            if (Date.now() > deadline) {
              throw new Error(
                `task ${launched.id} never reached a fully-recorded terminal state within 30s: ${JSON.stringify(item)}`,
              );
            }
            await Bun.sleep(500);
          }
        },
      );

      await hop(
        "the terminal task-result lands in the Inbox exactly once, carrying the same run id the task holds and the honest stub-key credential-error report",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/inbox`,
            undefined,
            user.cookies,
          );
          expectStatus("list inbox", res, 200);
          const items = (
            res.data as {
              items: { id: string; refs?: { kind: string; id: string }[] }[];
            }
          ).items;
          const matches = items.filter((item) =>
            (item.refs ?? []).some(
              (ref) => ref.kind === "run" && ref.id === launched.runId,
            ),
          );
          // Exactly once, not merely "at least once" — the orchestrator's
          // store-level winner-takes-all guard (`completeTask`'s
          // conditional UPDATE, see orchestrator.ts) is what this
          // asserts: a redelivered terminal event can never double-mail.
          expect(matches).toHaveLength(1);
          const delivered = matches[0];
          if (delivered === undefined) {
            throw new Error("unreachable: matches has length 1");
          }
          expect(delivered.id).toBe(terminal.resultMailId);

          // The delivered content is what proves this run's "done" is
          // the honest stub-key artifact, not a silently swallowed
          // failure: it names the real credential error the phase-A
          // stub key drew from the real Anthropic host. The list
          // projection above doesn't always carry a snippet; the
          // detail route does.
          const detailRes = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/inbox/${delivered.id}`,
            undefined,
            user.cookies,
          );
          expectStatus("get task-result inbox item", detailRes, 200);
          const body = stringField(
            detailRes.data,
            "body",
            "task-result inbox item",
          );
          // The status code is 401 today, but Anthropic controls it —
          // 403 is the same `credential_failure` category in the
          // vendor retry policy (`vendor/intx/inference/src/errors.ts`
          // classifies both identically), so accept either without
          // loosening the substantive check: the body must still name
          // a credential error, not merely any 4xx.
          if (!body.includes("credential error") || !/40[13]/.test(body)) {
            throw new Error(
              `expected the delivered task-result to report the stub key's credential error, got: ${JSON.stringify(detailRes.data)}`,
            );
          }
        },
      );

      await hop(
        "a second principal cannot read the task — creator-only privacy, not merely a missing grant",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/tasks/${launched.id}`,
            undefined,
            outsider.cookies,
          );
          expectStatus("outsider reads creator's task", res, 404);
        },
      );

      // --- Phase C, trace leg (CL-6055): the task→trace click-path,
      // server-side (CL-6061's "genuine top-level runs" scoping). ---

      await hop(
        "the dispatched task's run trace is readable through the insights trace route, with real span rows, and the run is absent from the tenant's scoped top-level-runs listing (CL-6061)",
        async () => {
          // `@corbits/insights`' `GET /runs/:runId/trace`
          // (packages/insights/src/routes.ts), mounted at
          // `${TENANT_PREFIX}/insights` in apps/hub/src/index.ts — the
          // same route the Inbox's "View run trace" button
          // (apps/web/src/pages/inbox-page.tsx) resolves through
          // `insightsRunTracePath`. The task's opening turn drew a real
          // 401 from the real Anthropic host (see the task leg's own
          // comments above), which the inference harness turns into a
          // completed turn — so `inference_turn`/`turn_part` rows exist
          // for this run regardless of the stub key, proving the reader
          // itself, not merely a happy-path reply.
          const traceRes = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/insights/runs/${launched.runId}/trace`,
            undefined,
            user.cookies,
          );
          expectStatus("get run trace", traceRes, 200);
          const trace = traceRes.data as {
            runId: string;
            spans: unknown[];
          };
          expect(trace.runId).toBe(launched.runId);
          if (!Array.isArray(trace.spans) || trace.spans.length === 0) {
            throw new Error(
              `expected real span rows for run ${launched.runId}, got: ${JSON.stringify(trace)}`,
            );
          }

          // CL-6061's contract: `listTopLevelRuns`
          // (packages/folded-runs/src/scope-routes.ts) excludes every
          // folded run — a task's run included, since `launchTask`
          // (packages/tasks/src/launcher.ts) launches through the same
          // `launchFoldedRun` that plants the `folded_run` marker row
          // this predicate's `NOT EXISTS` checks. The trace route above
          // proves the run is still reachable by id; this proves it
          // never leaks into the tenant's genuine-top-level-runs feed —
          // the two routes' complementary contracts, both proven
          // against the same real run.
          const topLevelRes = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/top-level-runs`,
            undefined,
            user.cookies,
          );
          expectStatus("list top-level runs", topLevelRes, 200);
          const topLevel = (topLevelRes.data as { data: { id: string }[] })
            .data;
          const leaked = topLevel.find((row) => row.id === launched.runId);
          if (leaked !== undefined) {
            throw new Error(
              `task run ${launched.runId} leaked into the scoped top-level-runs listing: ${JSON.stringify(leaked)}`,
            );
          }
        },
      );

      // --- Phase C, planner leg (CL-6055): the Myra "Let Myra choose"
      // route (packages/task-planner/src/routes.ts), proven fail-closed
      // against the same stub credential. ---

      await hop(
        "Myra's planner route fails closed with the stub credential — a 422 planning_failed envelope, no task created, no agent definition deployed, no inbox delivery",
        async () => {
          // `createPlannerRoutes`' one route, `POST /`, mounted at
          // `${TENANT_PREFIX}/planner` in apps/hub/src/index.ts — the
          // same route `packages/tasks-ui/src/api.ts`'s `dispatchPlanner`
          // calls when a person picks "Let Myra choose" in the Cmd/Ctrl+T
          // composer (`createMyraAgentSelectionStrategy`,
          // packages/tasks-ui/src/myra-agent-selection-strategy.tsx).
          //
          // With a real key, `dispatchWithPlanner` (packages/task-
          // planner/src/index.ts) resolves Myra's one-shot reply into a
          // validated `TaskSpec` and dispatches it exactly like a
          // manually-launched task — a real task row, a live agent
          // definition (for a `{create}` plan), and, once that task
          // reaches a terminal state, an Inbox delivery, mirroring the
          // task leg above.
          //
          // The stub key can't produce any of that: Myra's own one-shot
          // run (`runOneShotFoldedPrompt`, @corbits/folded-runs) dials
          // the same real Anthropic host with the same stub key as the
          // task leg, drawing the same real 401 — classified
          // `credential_failure` and folded into a *completed* turn
          // carrying a self-describing credential-error report as its
          // reply content (not a failed run bracket; see the task leg's
          // own comment for why). `runPlanner` (planner-run.ts) then
          // hands that content straight to `parseTaskSpec`
          // (task-spec.ts), which can only ever produce a `TaskSpec` or
          // throw `PlannerReplyUnparseableError` — a credential-error
          // report is neither valid JSON nor either `TaskSpec` shape, so
          // it throws. `PlannerReplyUnparseableError` is one of
          // `isPlanningFailure`'s named cases (routes.ts), so the route
          // never reaches `spawnFromTaskSpec` at all: it answers the
          // same honest `{error: {code: "planning_failed", message:
          // "Myra couldn't turn that into a task. Try rephrasing, or
          // pick an agent yourself."}}` envelope, 422, that a genuinely
          // unparseable reply from a real key would also produce —
          // proven empirically against this exact stub key, not
          // assumed.
          const tasksBefore = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/tasks`,
            undefined,
            user.cookies,
          );
          expectStatus("list tasks before planner dispatch", tasksBefore, 200);
          const taskCountBefore = (tasksBefore.data as { items: unknown[] })
            .items.length;

          const definitionsBefore = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/workflows/definitions`,
            undefined,
            user.cookies,
          );
          expectStatus(
            "list workflow definitions before planner dispatch",
            definitionsBefore,
            200,
          );
          const definitionCountBefore = (
            definitionsBefore.data as { data: unknown[] }
          ).data.length;

          const inboxBefore = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/inbox`,
            undefined,
            user.cookies,
          );
          expectStatus("list inbox before planner dispatch", inboxBefore, 200);
          const inboxCountBefore = (inboxBefore.data as { items: unknown[] })
            .items.length;

          const planRes = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenant.tenantId}/planner`,
            { outcome: `local-rip planner leg ${crypto.randomUUID()}` },
            user.cookies,
          );
          expectStatus("planner dispatch with stub credential", planRes, 422);
          const body = planRes.data as { error: { code: string } };
          expect(body.error.code).toBe("planning_failed");

          const tasksAfter = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/tasks`,
            undefined,
            user.cookies,
          );
          expectStatus("list tasks after planner dispatch", tasksAfter, 200);
          const taskCountAfter = (tasksAfter.data as { items: unknown[] }).items
            .length;
          expect(taskCountAfter).toBe(taskCountBefore);

          const definitionsAfter = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/workflows/definitions`,
            undefined,
            user.cookies,
          );
          expectStatus(
            "list workflow definitions after planner dispatch",
            definitionsAfter,
            200,
          );
          const definitionCountAfter = (
            definitionsAfter.data as { data: unknown[] }
          ).data.length;
          expect(definitionCountAfter).toBe(definitionCountBefore);

          const inboxAfter = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/inbox`,
            undefined,
            user.cookies,
          );
          expectStatus("list inbox after planner dispatch", inboxAfter, 200);
          const inboxCountAfter = (inboxAfter.data as { items: unknown[] })
            .items.length;
          expect(inboxCountAfter).toBe(inboxCountBefore);
        },
      );
    }, 180_000);
  },
);
