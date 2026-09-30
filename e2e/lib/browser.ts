// Browser e2e harness: boots the hub in-process on a disposable data dir,
// serves the built apps/web bundle from the same origin (the hub itself
// serves no static files), and drives it with puppeteer-core against a
// local Chrome. A UI test file calls `bootBrowserApp()` once and gets a
// fresh page per test via `newPage()`.
import { afterAll, beforeAll, describe } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { dbGate } from "./db-gate";
import { installDisposableHubDataDir } from "./disposable-hub-data-dir";
import { REPO_ROOT } from "./database-url";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEB_DIR = path.join(REPO_ROOT, "apps", "web");
const DIST_DIR = path.join(WEB_DIR, "dist");

export function chromePath(): string | undefined {
  const candidates = [process.env["CHROME_PATH"], DEFAULT_CHROME].filter(
    (p): p is string => p !== undefined && p !== "",
  );
  return candidates.find((p) => existsSync(p));
}

/**
 * `describe` when Chrome and DATABASE_URL are available, else a loud
 * skip locally. CI=true turns either gap into a hard failure.
 */
export function browserGate(label: string): typeof describe {
  if (chromePath() === undefined && process.env["CI"] === "true") {
    throw new Error(`Chrome not found; "${label}" cannot run. Set CHROME_PATH.`);
  }
  const gate = dbGate(process.env["DATABASE_URL"], label);
  if (chromePath() === undefined) {
    process.stderr.write(`${label}: Chrome not found (set CHROME_PATH); suite skipped.\n`);
    return describe.skip;
  }
  return gate;
}

export type BrowserApp = {
  origin: string;
  /** Opens a page that records console errors and uncaught exceptions. */
  newPage: () => Promise<{ page: Page; errors: string[] }>;
};

async function ensureWebBuild(): Promise<void> {
  if (existsSync(path.join(DIST_DIR, "index.html"))) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: WEB_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error("apps/web build failed");
}

/** Registers beforeAll/afterAll that boot and tear down hub + web + Chrome. */
export function bootBrowserApp(): () => BrowserApp {
  installDisposableHubDataDir();
  let app: BrowserApp | undefined;
  let browser: Browser | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    const executablePath = chromePath();
    if (executablePath === undefined) throw new Error("Chrome not found");
    await ensureWebBuild();

    const url = new URL(process.env["DATABASE_URL"] ?? "");
    process.env["DB_HOST"] = url.hostname;
    process.env["DB_PORT"] = url.port === "" ? "5432" : url.port;
    process.env["DB_USER"] = decodeURIComponent(url.username);
    process.env["DB_PASSWORD"] = decodeURIComponent(url.password);
    process.env["DB_NAME"] = url.pathname.replace(/^\//, "");
    process.env["CREDENTIAL_ENCRYPTION_KEY"] ??= "0".repeat(64);
    process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"] ??= "1".repeat(64);
    process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] ??= "2".repeat(64);
    process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"] = "1";

    // Bind first so BASE_URL (Better Auth's trusted origin) names the real port.
    server = Bun.serve({ port: 0, fetch: () => new Response("booting", { status: 503 }) });
    const origin = `http://localhost:${String(server.port)}`;
    process.env["BASE_URL"] = origin;
    // The in-process sidecar dials the hub's own port back over WebSocket.
    process.env["PORT"] = String(server.port);

    const { createHubServer } = await import("../../apps/hub/src/server");
    const hub = await createHubServer();
    server.reload({
      websocket: hub.websocket as Bun.WebSocketHandler<unknown>,
      fetch: async (req, srv) => {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/api") || pathname === "/status") return hub.fetch(req, srv);
        const file = Bun.file(path.join(DIST_DIR, pathname));
        if (pathname !== "/" && (await file.exists())) return new Response(file);
        return new Response(Bun.file(path.join(DIST_DIR, "index.html")));
      },
    });

    // Ubuntu runners block Chrome's user-namespace sandbox via AppArmor.
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: process.env.CI === "true" ? ["--no-sandbox"] : [],
    });
    const launched = browser;
    app = {
      origin,
      newPage: async () => {
        const page = await launched.newPage();
        const errors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(String(err)));
        return { page, errors };
      },
    };
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop(true);
  });

  return () => {
    if (app === undefined) throw new Error("bootBrowserApp: app not booted");
    return app;
  };
}
