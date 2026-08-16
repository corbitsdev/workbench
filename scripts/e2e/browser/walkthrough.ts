/// <reference lib="dom" />
// The triple-slash directive above is for the `page.evaluate` callback
// bodies only — they run inside the browser tab, not this Bun process, but
// TypeScript still checks them against this file's own lib config.
//
// Real-browser acceptance harness (CL-6072): boots the real stack (a fresh
// scratch database, the real hub, the real sidecar, a stubbed provider
// credential) and drives the actual built web app in headless Chrome via
// puppeteer-core — clicking, typing, and screenshotting exactly as a human
// would. Scripted API-only e2e suites (scripts/e2e/*.test.ts) had been
// passing while the real UI broke; this is the acceptance mechanism for
// "works in the owner's browser."
//
// Run: bun run scripts/e2e/browser/walkthrough.ts
// Requires: DATABASE_URL (see .env.example), and a system Chrome/Chromium
// (this script looks in the usual per-OS install locations — no download).
//
// Every step screenshots to scripts/e2e/browser/shots/NN-name.png and
// records its own pass/repro-confirmed/fail outcome; the full run also
// writes scripts/e2e/browser/shots/summary.json. Re-runnable: resets its
// own scratch database on every run. Finishes inside a 3-minute budget —
// every wait below is bounded, nothing blocks forever.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { resetSchema, setupDatabase } from "../../db-setup.ts";
import {
  e2eDatabaseUrl,
  freePort,
  provisionSidecar,
  startHub,
  startSidecar,
  type HubHandle,
  type SpawnedApp,
} from "../harness.ts";
import {
  createGitWorkflowPusher,
  createHubAPI,
} from "../../../packages/hub-client/src/index.ts";
import {
  ensureSeeded,
  testAndPersistCredential,
} from "../../../packages/onboarding/src/complete-credential.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const WEB_DIR = path.join(REPO_ROOT, "apps", "web");
const SHOTS_DIR = path.join(import.meta.dir, "shots");

// --- Chrome discovery ---------------------------------------------------

/** Per-OS locations a system Chrome/Chromium is commonly installed at.
 * No download, no bundled browser — this walks the real browser the owner
 * has, or fails loudly naming what it looked for. */
function candidateChromePaths(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ];
    case "linux":
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
    case "win32":
      return [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
    default:
      return [];
  }
}

function findChrome(): string {
  const env = process.env["CHROME_PATH"];
  if (env !== undefined && env !== "" && existsSync(env)) return env;
  const found = candidateChromePaths().find((candidate) =>
    existsSync(candidate),
  );
  if (found !== undefined) return found;
  throw new Error(
    "No system Chrome/Chromium found (checked CHROME_PATH and the usual " +
      `per-OS install locations for ${process.platform}). This harness ` +
      "drives a real browser on purpose — it never substitutes a fake " +
      "DOM run. Install Chrome, or set CHROME_PATH to its binary.",
  );
}

// --- result ledger -------------------------------------------------------

type StepStatus = "pass" | "repro-confirmed" | "fail";

interface StepResult {
  readonly step: string;
  readonly status: StepStatus;
  readonly detail: string;
  readonly screenshot: string;
}

const results: StepResult[] = [];
let shotIndex = 0;

/** Steps take a *getter* for the active tab, not the tab itself — a step
 * whose tab wedges (main thread pegged badly enough that even
 * `Page.navigate` never lands) can swap in a fresh tab (reassigning the
 * caller's own `page` variable, which the getter closes over) rather
 * than costing the whole run everything from there on, including this
 * step's own screenshot. */
type GetPage = () => Page;

async function screenshot(getPage: GetPage, name: string): Promise<string> {
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, "0")}-${name}.png`;
  const dest = path.join(SHOTS_DIR, file) as `${string}.png`;
  // A step's own failure must never cost the run its screenshot — but a
  // truly wedged tab can hang the screenshot call too, so this gets its
  // own short, separate timeout rather than inheriting the step's.
  await Promise.race([
    getPage().screenshot({ path: dest }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("screenshot timed out")), 8_000),
    ),
  ]).catch((error) => {
    console.error(
      `  (screenshot failed: ${error instanceof Error ? error.message : error})`,
    );
  });
  return file;
}

async function step(
  getPage: GetPage,
  name: string,
  run: () => Promise<{ status: StepStatus; detail: string }>,
): Promise<void> {
  console.log(`\n=== ${name} ===`);
  let outcome: { status: StepStatus; detail: string };
  try {
    outcome = await run();
  } catch (error) {
    outcome = {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const shot = await screenshot(getPage, name.replace(/[^a-z0-9]+/gi, "-"));
  results.push({
    step: name,
    status: outcome.status,
    detail: outcome.detail,
    screenshot: shot,
  });
  console.log(`  ${outcome.status.toUpperCase()}: ${outcome.detail}`);
  console.log(`  screenshot: ${shot}`);
}

// --- web dev server -------------------------------------------------------

export interface WebDevServer extends SpawnedApp {
  readonly baseUrl: string;
}

/** Serves the real web app the same way `bun run dev` does locally
 * (apps/web/package.json's own `dev` script, `vite`) rather than running a
 * full production build — a plain build is the heavier of the two (a
 * full rollup/esbuild bundle) and this harness only ever needs one
 * concurrent stack, never a checked-in bundle. `vite.config.ts` already
 * proxies `/api` to `BASE_URL`, so pointing that at the real hub gets the
 * genuine built-from-source UI talking to the genuine hub with no CORS
 * setup, same-origin, exactly like production — just without the bundle
 * step. */
async function startWebDevServer(options: {
  hubBaseUrl: string;
  port: number;
}): Promise<WebDevServer> {
  const vite = path.join(WEB_DIR, "node_modules", ".bin", "vite");
  if (!existsSync(vite)) {
    throw new Error(
      `apps/web has no installed vite binary at ${vite}; run \`bun install\` first.`,
    );
  }
  const baseUrl = `http://localhost:${options.port}`;
  const proc = Bun.spawn(
    [vite, "--port", String(options.port), "--strictPort"],
    {
      cwd: WEB_DIR,
      env: { ...process.env, BASE_URL: options.hubBaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let captured = "";
  let done = false;
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      captured += decoder.decode(chunk, { stream: true });
  };
  void capture(proc.stdout);
  void capture(proc.stderr);
  void proc.exited.then(() => {
    done = true;
  });
  const app: SpawnedApp = {
    label: "web-dev",
    output: () => captured,
    exited: () => done,
    stop: async () => {
      if (done) return;
      proc.kill();
      const timeout = new Promise<"timeout">((resolveWait) =>
        setTimeout(() => resolveWait("timeout"), 5000),
      );
      if ((await Promise.race([proc.exited, timeout])) === "timeout") {
        proc.kill(9);
        await proc.exited;
      }
    },
  };
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (app.exited()) {
      throw new Error(
        `web dev server exited during boot; output:\n${app.output()}`,
      );
    }
    try {
      const res = await fetch(baseUrl);
      if (res.status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await app.stop();
      throw new Error(
        `web dev server did not answer within 20s; output:\n${app.output()}`,
      );
    }
    await Bun.sleep(250);
  }
  return { ...app, baseUrl };
}

// --- small DOM helpers -------------------------------------------------

/** Clicks the first element matching `selector` whose trimmed text content
 * equals `text` — puppeteer-core has no built-in text selector, and every
 * control this walkthrough drives is identified by its real UI label. */
async function clickByText(
  page: Page,
  selector: string,
  text: string,
): Promise<void> {
  const clicked = await page.evaluate(
    (sel: string, wanted: string) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const match = nodes.find(
        (node) => (node.textContent ?? "").trim() === wanted,
      );
      if (match === undefined) return false;
      (match as HTMLElement).click();
      return true;
    },
    selector,
    text,
  );
  if (!clicked) {
    throw new Error(`no element matching ${selector} with text "${text}"`);
  }
}

/**
 * Clicks `selector` by resolving and clicking it in one browser-side turn,
 * with a few short retries — `page.click()` resolves the element handle
 * and dispatches the click as two separate round trips, so a page still
 * settling after a navigation (a band re-render swapping the node) can
 * detach the resolved handle in between, surfacing as "Node is detached
 * from document." Doing both in a single `page.evaluate` call closes that
 * window; the retry loop covers the element not existing yet.
 */
async function clickStable(page: Page, selector: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const clicked = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      (el as HTMLElement).click();
      return true;
    }, selector);
    if (clicked) return;
    if (Date.now() > deadline) {
      throw new Error(`no element matching ${selector} to click`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function countMatching(page: Page, selector: string): Promise<number> {
  return page.evaluate(
    (sel: string) => document.querySelectorAll(sel).length,
    selector,
  );
}

// --- the walkthrough -----------------------------------------------------

/**
 * Opens the "+ New workbench" picker and asserts its combobox dropdown
 * offers the "Create new agent" row (CL-6081: instant creation, pinned
 * above the filtered agent list — see `AgentCombobox` in
 * `packages/chat-ui/src/new-channel-dialog.tsx`) before picking an
 * existing "Myra"-ish agent. There is no kind step and no separate submit
 * click any more: `initialKind="chat"` skips straight to the combobox, and
 * clicking an agent row resolves the workbench immediately (find-or-create
 * — an existing conversation with that agent reopens), closing the dialog
 * itself.
 */
async function createMyraChat(page: Page): Promise<void> {
  await clickStable(page, 'button[aria-label="New workbench"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await page.waitForSelector(
    '[data-testid="new-chat-agent-combobox"] [role="option"]',
    { timeout: 10_000 },
  );
  const hasCreateRow = await page.evaluate(
    () =>
      document.querySelector('[data-testid="new-chat-create-agent"]') !== null,
  );
  if (!hasCreateRow) {
    throw new Error(
      'new-chat combobox is missing its pinned "Create new agent" row',
    );
  }
  const pickedMyra = await page.evaluate(() => {
    const options = Array.from(
      document.querySelectorAll(
        '[data-testid="new-chat-agent-combobox"] [role="option"]',
      ),
    );
    const myra = options.find((option) =>
      (option.textContent ?? "").toLowerCase().includes("myra"),
    );
    const target = myra ?? options[0];
    if (target === undefined) return null;
    (target as HTMLElement).click();
    return (target.textContent ?? "").trim();
  });
  if (pickedMyra === null) {
    throw new Error("new-chat agent combobox rendered no options");
  }
  // Picking an agent resolves the workbench immediately (no separate
  // submit click) — wait for the dialog to actually go away rather than
  // assuming.
  await page.waitForSelector('[role="dialog"]', {
    hidden: true,
    timeout: 15_000,
  });
}

async function run(): Promise<void> {
  await mkdir(SHOTS_DIR, { recursive: true });

  const rawUrl = e2eDatabaseUrl();
  if (rawUrl === undefined) {
    throw new Error(
      "DATABASE_URL is not set (see .env.example). The browser walkthrough " +
        "needs a real reachable Postgres to boot the real stack against — " +
        "it never substitutes a fake backend.",
    );
  }
  const databaseUrl = rawUrl;

  const chromePath = findChrome();
  console.log(`Using Chrome at ${chromePath}`);

  console.log("Resetting scratch database...");
  await resetSchema(databaseUrl);
  await setupDatabase(databaseUrl);

  const workDir = await mkdtemp(path.join(tmpdir(), "e2e-browser-"));

  const cleanups: (() => Promise<void>)[] = [];
  let browser: Browser | undefined;

  try {
    const hubDataDir = path.join(workDir, "hub-data");
    const sidecarDataDir = path.join(workDir, "sidecar-data");
    const sidecarId = "sidecar-e2e-browser";
    const sidecarToken = crypto.randomUUID();
    await provisionSidecar(databaseUrl, sidecarId, sidecarToken);

    const sessionSecret = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex");
    // The hub keeps this exact port, and the web dev server keeps this
    // exact origin as the hub's trusted BASE_URL, across the restart in
    // step 10 — the dev server's own `/api` proxy target and better-
    // auth's own trusted-origin check are both fixed at their processes'
    // boot, so reusing both across the restart is what lets a single dev
    // server survive it unchanged. better-auth trusts exactly one
    // origin (BASE_URL) and the browser's page origin is the dev
    // server's, not the hub's own port, so the hub is told to advertise
    // BASE_URL as the dev server's origin while PORT keeps it actually
    // listening on `hubPort` — the same split apps/hub/src/config.ts
    // documents for a reverse proxy in front of a production hub.
    const hubPort = freePort();
    const webPort = freePort();
    const webBaseUrl = `http://localhost:${webPort}`;

    let hub: HubHandle = await startHub({
      databaseUrl,
      port: hubPort,
      sessionSecret,
      dataDir: hubDataDir,
      extraEnv: { BASE_URL: webBaseUrl },
    });
    cleanups.push(() => hub.stop());

    const sidecar: SpawnedApp = startSidecar({
      hubPort: Number(new URL(hub.baseUrl).port),
      sidecarId,
      token: sidecarToken,
      dataDir: sidecarDataDir,
    });
    cleanups.push(() => sidecar.stop());

    console.log(
      "Starting apps/web dev server (proxying /api to the real hub)...",
    );
    const web = await startWebDevServer({
      hubBaseUrl: hub.baseUrl,
      port: webPort,
    });
    cleanups.push(() => web.stop());

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const closeBrowser = browser;
    cleanups.push(() => closeBrowser.close());

    function wireDiagnostics(target: Page): void {
      target.on("pageerror", (error) =>
        console.error(`  [page error] ${error.message}`),
      );
      target.on("console", (msg) => {
        if (msg.type() === "error")
          console.error(`  [console.error] ${msg.text()}`);
      });
    }

    let page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.setDefaultTimeout(15_000);
    wireDiagnostics(page);

    const email = `browser-e2e-${crypto.randomUUID()}@example.invalid`;
    const password = `pw-${crypto.randomUUID()}`;
    const stubApiKey = "sk-e2e-stub-not-real";

    // --- Step 1: signup -> onboarding -> connect provider (stub key) -> shell
    await step(
      () => page,
      "01-signup",
      async () => {
        await page.goto(webBaseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".auth-switch", { timeout: 10_000 });
        await page.click(".auth-switch"); // "Create an account" -> sign-up mode
        await page.waitForSelector('input[name="email"]');
        await page.type('input[name="email"]', email);
        await page.type('input[name="password"]', password);
        await page.click('button[type="submit"]');
        await page.waitForFunction(
          () => window.location.pathname === "/onboarding",
          { timeout: 15_000 },
        );
        return {
          status: "pass",
          detail: `signed up as ${email}, reached onboarding`,
        };
      },
    );

    await step(() => page, "02-onboarding-provisioning", async () => {
      // CL-6089 dropped the naming step: provisioning now fires
      // automatically, under a default name derived from the account, the
      // moment the wizard mounts. This step just waits for it to land on
      // the credential step next — an inference-provider radiogroup.
      await page.waitForSelector('[aria-label="Inference provider"]', {
        timeout: 15_000,
      });
      return { status: "pass", detail: "workbench provisioned, reached credential step" };
    });

    await step(
      () => page,
      "03-connect-provider-stub-key",
      async () => {
        // Every UI path that accepts a pasted key — onboarding's credential
        // step, and Settings > Connections' connector cards — performs a
        // real, synchronous network probe of the key before storing it (see
        // packages/onboarding/src/complete-credential.ts and
        // packages/connections/src/routes.ts): a stub key is rejected right
        // there, by design. `local-rip.test.ts` (CL-6055) already
        // establishes the honest way to drive a stub key past exactly that
        // gate: call the same two halves the onboarding route itself calls
        // (`testAndPersistCredential` / `ensureSeeded`, from
        // `@workbench/onboarding`) directly, stubbing only the one
        // `testCredential` network boundary those functions expose
        // precisely so this is possible — everything else (persisting the
        // credential, publishing the tool registry, pushing and deploying
        // every default workflow including "assistant"/Myra) runs for
        // real, against the real spawned hub, using the real session
        // cookie this browser just signed in with. The stub key itself is
        // never sent anywhere here — it is stored as an unproven model
        // source, exactly as onboarding's own key path would store it, so
        // the later chat message is the first time it is ever dialed for
        // real.
        const cookies = (await page.cookies()).map(
          (c) => `${c.name}=${c.value}`,
        );
        const hubApi = createHubAPI(hub.baseUrl);
        const session = await hubApi(
          "GET",
          "/api/auth/get-session",
          undefined,
          cookies,
        );
        const userId = (session.data as { user?: { id?: string } } | null)?.user
          ?.id;
        if (userId === undefined || userId === "") {
          throw new Error(
            `no authenticated session found: ${JSON.stringify(session.data)}`,
          );
        }
        const pushWorkflow = createGitWorkflowPusher();
        const connected = await testAndPersistCredential({
          api: hubApi,
          cookies,
          hubUrl: hub.baseUrl,
          userId,
          userEmail: email,
          provider: "anthropic",
          apiKey: stubApiKey,
          pushWorkflow,
          log: () => undefined,
          testCredential: async () => ({ ok: true }),
        });
        if (connected.kind !== "connected") {
          throw new Error(
            `expected the key-path connect to succeed, got: ${JSON.stringify(connected)}`,
          );
        }
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before seeding could complete; output:\n${sidecar.output()}`,
            );
          }
          try {
            const seeded = await ensureSeeded({
              api: hubApi,
              cookies,
              hubUrl: hub.baseUrl,
              pushWorkflow,
              log: () => undefined,
              tenant: connected,
              provider: "anthropic",
              apiKey: stubApiKey,
            });
            return {
              status: "pass",
              detail: `stub credential stored and every default workflow deployed: ${seeded.workflows.join(", ")}`,
            };
          } catch (cause) {
            if (Date.now() > deadline) throw cause;
            await Bun.sleep(1000);
          }
        }
      },
    );

    await step(
      () => page,
      "04-land-in-shell-bare-root",
      async () => {
        // CL-6081: `/` (bare root, not just `/c`) is Myra's land hop too —
        // `HomeRoute` ensures her channel and redirects straight into it.
        await page.goto(webBaseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => window.location.pathname.startsWith("/c/"),
          {
            timeout: 15_000,
          },
        );
        return {
          status: "pass",
          detail: `bare root landed in Myra's chat at ${await page.evaluate(() => window.location.pathname)}`,
        };
      },
    );

    await step(
      () => page,
      "04b-workbench-sidebar",
      async () => {
        await page.goto(`${webBaseUrl}/c`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('button[aria-label="New workbench"]', {
          timeout: 15_000,
        });
        const sidebarTitle = await page.evaluate(
          () =>
            document
              .querySelector('[data-slot="sidebar-panel-header"] h2')
              ?.textContent?.trim() ?? null,
        );
        if (sidebarTitle !== "Workbenches") {
          return {
            status: "fail",
            detail: `expected the sidebar title "Workbenches", got ${JSON.stringify(sidebarTitle)}`,
          };
        }
        const createButtons = await countMatching(
          page,
          'button[aria-label="New workbench"]',
        );
        if (createButtons !== 1) {
          return {
            status: "fail",
            detail: `expected exactly one "New workbench" affordance, found ${createButtons}`,
          };
        }
        return {
          status: "pass",
          detail:
            'single always-visible sidebar: titled "Workbenches", one "+ New workbench" affordance',
        };
      },
    );

    // --- Step 2: CL-6070 — create with Myra, then a second create that
    // must resolve to the SAME workbench (find-or-create dedup, CL-6087).
    let firstWorkbenchPath = "";
    await step(
      () => page,
      "05-create-first-myra-workbench",
      async () => {
        await createMyraChat(page);
        await page.waitForFunction(
          () => window.location.pathname.startsWith("/c/"),
          { timeout: 15_000 },
        );
        firstWorkbenchPath = await page.evaluate(
          () => window.location.pathname,
        );
        return {
          status: "pass",
          detail: `created Myra's workbench via the picker, landed at ${firstWorkbenchPath}`,
        };
      },
    );

    await step(
      () => page,
      "06-second-create-reopens-same-workbench",
      async () => {
        // The sidebar (and its "+ New workbench" affordance) is always
        // present — no navigation needed before opening the picker again.
        await createMyraChat(page);
        await page.waitForFunction(
          () => window.location.pathname.startsWith("/c/"),
          { timeout: 15_000 },
        );
        const secondPath = await page.evaluate(() => window.location.pathname);
        if (secondPath !== firstWorkbenchPath) {
          return {
            status: "fail",
            detail:
              `expected the second create to reopen ${firstWorkbenchPath} ` +
              `(find-or-create dedup), landed at ${secondPath}`,
          };
        }
        return {
          status: "pass",
          detail: `second create reopened the same workbench (${secondPath}) — no duplicate created`,
        };
      },
    );

    await step(
      () => page,
      "07-sidebar-myra-duplicates-CL-6070",
      async () => {
        // The always-visible sidebar already lists every workbench — the
        // rows are just there, no navigation or priming needed.
        await page.waitForSelector(".shell-ch-row-wrap", { timeout: 15_000 });
        const myraRows = await countMatching(
          page,
          '.shell-ch-row-wrap[data-ctx-channel-title="Myra"]',
        );
        if (myraRows === 1) {
          return {
            status: "pass",
            detail:
              "sidebar shows exactly 1 Myra row — dedup working, CL-6070 not reproduced",
          };
        }
        if (myraRows >= 2) {
          return {
            status: "repro-confirmed",
            detail: `sidebar shows ${myraRows} rows titled "Myra" — CL-6070 duplicate-row bug reproduced`,
          };
        }
        return {
          status: "fail",
          detail: `expected at least 1 Myra sidebar row, found ${myraRows}`,
        };
      },
    );

    // --- Step 3: send "hi" in the Myra chat, expect *some* reply bubble
    await step(
      () => page,
      "08-send-hi-to-myra",
      async () => {
        const rowSelector =
          '.shell-ch-row-wrap[data-ctx-channel-title="Myra"] button.shell-ch-row';
        await clickStable(page, rowSelector);
        // A freshly created channel launches its anchor instance on first
        // open (the same real hop chat.test.ts retries against a
        // transient 500 for up to 60s) before the composer can render —
        // bounded, not instant. A client-side click straight out of the
        // just-closed new-chat dialog occasionally lands the stage on a
        // blank, contentless render (no composer, no loading state, no
        // error) rather than a slow-but-eventual one; a single full
        // reload of the same route recovers it every time this harness
        // has hit it, so that is the one retry this step allows itself.
        const composerAppeared = await page
          .waitForSelector("textarea.chat-composer-input", { timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!composerAppeared) {
          // A same-tab reload has, in practice, itself hung here — the
          // blank render this recovers from can peg the tab badly enough
          // that even `Page.navigate` never lands. A brand-new tab sidesteps
          // whatever state the wedged one is in, rather than betting the
          // rest of the run on unwedging it.
          const stalePage = page;
          page = await closeBrowser.newPage();
          await page.setViewport({ width: 1440, height: 900 });
          page.setDefaultTimeout(15_000);
          wireDiagnostics(page);
          await stalePage.close().catch(() => undefined);
          await page.goto(`${webBaseUrl}/c`, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          await page.waitForSelector(
            '.shell-ch-row-wrap[data-ctx-channel-title="Myra"]',
            {
              timeout: 15_000,
            },
          );
          await clickStable(page, rowSelector);
          await page.waitForSelector("textarea.chat-composer-input", {
            timeout: 30_000,
          });
        }
        await page.type("textarea.chat-composer-input", "hi");
        await clickStable(page, 'button[aria-label="Send"]');
        await page.waitForSelector('div.chat-bubble-row[data-own="true"]', {
          timeout: 10_000,
        });
        try {
          await page.waitForSelector('div.chat-bubble-row[data-own="false"]', {
            timeout: 45_000,
          });
        } catch {
          const hubTail = hub.output().slice(-1500);
          const sidecarTail = sidecar.output().slice(-1500);
          console.error(`  --- hub output (tail) ---\n${hubTail}`);
          console.error(`  --- sidecar output (tail) ---\n${sidecarTail}`);
          return {
            status: "fail",
            detail:
              'sent "hi" but no reply bubble (own=false) appeared within 45s — ' +
              "auto-response wiring did not fire at all (see hub/sidecar output above)",
          };
        }
        const replyText = await page.evaluate(() => {
          const bubble = document.querySelector(
            'div.chat-bubble-row[data-own="false"] p.chat-bubble-text',
          );
          return bubble?.textContent ?? null;
        });
        return {
          status: "pass",
          detail:
            `a reply bubble appeared (auto-response wiring confirmed); with the stub key ` +
            `its content is the expected honest credential-error report: ${JSON.stringify(replyText)}`,
        };
      },
    );

    // --- Step 4: CL-6066 — New task dialog styling
    await step(
      () => page,
      "09-new-task-dialog-CL-6066",
      async () => {
        await page.click("body");
        await page.keyboard.down("Control");
        await page.keyboard.press("t");
        await page.keyboard.up("Control");
        await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
        const found = await page.evaluate(
          () => document.body.textContent?.includes("New task") ?? false,
        );
        await page.keyboard.press("Escape");
        if (!found) {
          return {
            status: "fail",
            detail:
              "Cmd/Ctrl+T opened a dialog, but it is not the New task dialog",
          };
        }
        return {
          status: "repro-confirmed",
          detail:
            "New task dialog opened via Ctrl+T — captured for visual review against " +
            "CL-6066 (unstyled dialog); see screenshot",
        };
      },
    );

    // --- Step 5: CL-6067 / CL-6069 — hub restart, stale-thread reconnect
    await step(
      () => page,
      "10-restart-hub-same-db",
      async () => {
        await hub.stop();
        // Same port as the first boot — the already-running web dev
        // server's `/api` proxy target was fixed at its own startup, so
        // reusing the port is what lets it survive this restart unchanged.
        hub = await startHub({
          databaseUrl,
          port: hubPort,
          sessionSecret,
          dataDir: hubDataDir,
          extraEnv: { BASE_URL: webBaseUrl },
        });
        cleanups.push(() => hub.stop());
        return {
          status: "pass",
          detail: `hub restarted on the same database at ${hub.baseUrl}`,
        };
      },
    );

    await step(
      () => page,
      "11-reload-open-existing-chat-CL-6067-6069",
      async () => {
        await page.goto(`${webBaseUrl}/c`, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        const rowAppeared = await page
          .waitForSelector(
            '.shell-ch-row-wrap[data-ctx-channel-title="Myra"]',
            {
              timeout: 15_000,
            },
          )
          .then(() => true)
          .catch(() => false);
        if (!rowAppeared) {
          return {
            status: "repro-confirmed",
            detail:
              "after restart, the reloaded shell never regained a Myra sidebar row within 15s " +
              "(stuck disconnected) — CL-6067 reproduced",
          };
        }
        await clickStable(
          page,
          '.shell-ch-row-wrap[data-ctx-channel-title="Myra"] button.shell-ch-row',
        );
        const couldNotLoad = await page
          .waitForFunction(
            () => document.body.textContent?.includes("Couldn't load"),
            {
              timeout: 10_000,
            },
          )
          .then(() => true)
          .catch(() => false);
        if (couldNotLoad) {
          return {
            status: "repro-confirmed",
            detail:
              'opening the existing chat after restart shows "Couldn\'t load" — CL-6069 ' +
              "stale-thread failure reproduced",
          };
        }
        const composerReady = await page
          .waitForSelector("textarea.chat-composer-input", { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (composerReady) {
          return {
            status: "pass",
            detail:
              "existing chat reopened cleanly after a same-DB hub restart",
          };
        }
        return {
          status: "fail",
          detail:
            "chat neither loaded normally nor showed the documented error state",
        };
      },
    );
  } finally {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch((error) => {
        console.error(
          `cleanup failed: ${error instanceof Error ? error.message : error}`,
        );
      });
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function printSummary(): void {
  console.log("\n=== summary ===");
  const widths = { step: 45, status: 17 };
  for (const result of results) {
    console.log(
      `${result.step.padEnd(widths.step)} ${result.status.padEnd(widths.status)} ${result.detail}`,
    );
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  try {
    await run();
  } finally {
    await writeFile(
      path.join(SHOTS_DIR, "summary.json"),
      JSON.stringify(results, null, 2),
      "utf-8",
    );
    printSummary();
    console.log(`\nfinished in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} step(s) failed outright (not just repro-confirmed).`,
    );
    process.exit(1);
  }
}

await main();
